/*
PenguinMod / TurboWarp extension: PNG -> SVG embedder
- Uses the TurboWarp "files" extension (tries multiple common method names) to read a PNG file
  as base64, extracts width/height from the PNG header, and creates a simple SVG that embeds
  the PNG as a raster <image> (data URL). This is the quickest, lossless way to "convert"
  a PNG into an SVG container.

How to use:
- Load this JS as a Scratch/TurboWarp extension (PenguinMod supports loading custom extensions).
- Use the block "convert PNG file [inFile] to SVG named [outName]".
- The extension will attempt to save the generated SVG using the files extension and returns
  the saved filename (or a data URL if saving isn't available).

Notes:
- This does not vectorize the bitmap. It wraps the PNG raster inside an SVG.
- The code attempts several fallbacks to be compatible with different versions of the
  TurboWarp/PenguinMod files API.
*/

class PNGtoSVGExtension {
    constructor(runtime) {
        this.runtime = runtime;
        // Bind so blocks can be used as callbacks
        this.convertPNG = this.convertPNG.bind(this);
    }

    getInfo() {
        return {
            id: 'pngToSvg',
            name: 'PNG → SVG',
            blocks: [
                {
                    opcode: 'convertPNG',
                    blockType: 'reporter',
                    text: 'convert PNG file [INFILE] to SVG named [OUTNAME]',
                    arguments: {
                        INFILE: { type: 'string', defaultValue: 'image.png' },
                        OUTNAME: { type: 'string', defaultValue: 'image-converted' }
                    }
                }
            ]
        };
    }

    /* Helper: try to find the files extension API on the runtime. Returns an object with
       read and write functions (or null if not available). We provide multiple fallbacks
       for different method names used across versions. */
    _findFilesAPI() {
        // Some engines attach extensions keyed by id; others expose them differently.
        const extCandidates = this.runtime.extensions ? Object.values(this.runtime.extensions) : [];

        // Helper to normalise a candidate object into {read, write}
        const asApi = (obj) => {
            if (!obj) return null;
            const api = {};
            // read: try various method names expected to return base64 or text
            if (typeof obj.read === 'function') api.read = obj.read.bind(obj);
            else if (typeof obj.readFile === 'function') api.read = obj.readFile.bind(obj);
            else if (typeof obj.get === 'function') api.read = obj.get.bind(obj);
            else if (typeof obj.getFile === 'function') api.read = obj.getFile.bind(obj);

            // write: try various method names used to save files
            if (typeof obj.write === 'function') api.write = obj.write.bind(obj);
            else if (typeof obj.writeFile === 'function') api.write = obj.writeFile.bind(obj);
            else if (typeof obj.save === 'function') api.write = obj.save.bind(obj);
            else if (typeof obj.saveFile === 'function') api.write = obj.saveFile.bind(obj);
            else if (typeof obj.set === 'function') api.write = obj.set.bind(obj);

            // Some implementations expose a simple files object: obj.files[name] = base64
            if (!api.read && obj.files && typeof obj.files === 'object') {
                api.read = (name) => Promise.resolve(obj.files[name]);
            }

            // If at least one operation exists, return api
            if (api.read || api.write) return api;
            return null;
        };

        // Direct check for a known TurboWarp files extension id
        try {
            const maybe = this.runtime.extensions && (this.runtime.extensions['turbowarp-files'] || this.runtime.extensions['files']);
            const a = asApi(maybe);
            if (a) return a;
        } catch (e) {
            // ignore
        }

        for (const candidate of extCandidates) {
            const a = asApi(candidate);
            if (a) return a;
        }

        return null;
    }

    /* Parse PNG width & height from a base64-encoded PNG. Returns {width, height} or null on failure.
       PNG format: signature (8 bytes) + length(4) + 'IHDR'(4) then IHDR data starts: width 4 bytes, height 4 bytes
       We'll decode base64 via atob and read bytes. */
    _pngSizeFromBase64(base64) {
        try {
            // strip data URL prefix if present
            const comma = base64.indexOf(',');
            if (comma >= 0) base64 = base64.slice(comma + 1);

            const bin = atob(base64);
            // need at least 24 + 8 bytes
            if (bin.length < 24) return null;
            // width bytes are at offsets 16..19
            const w = (bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16) | (bin.charCodeAt(18) << 8) | (bin.charCodeAt(19));
            const h = (bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16) | (bin.charCodeAt(22) << 8) | (bin.charCodeAt(23));
            // JS bitwise operates on signed 32-bit; ensure unsigned
            return { width: w >>> 0, height: h >>> 0 };
        } catch (e) {
            return null;
        }
    }

    /* Create the SVG string embedding the PNG base64. If width/height are known, include them. */
    _makeSvgString(base64, width, height) {
        // Ensure no data: prefix duplicates
        let b64 = base64;
        const idx = b64.indexOf('base64,');
        if (idx >= 0) b64 = b64.slice(idx + 7);

        // Default viewbox if missing
        const w = width || '100%';
        const h = height || '100%';

        const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${width || 100} ${height || 100}">\n` +
            `  <image href="data:image/png;base64,${b64}" width="${w}" height="${h}" preserveAspectRatio="none" />\n` +
            `</svg>`;
        return svg;
    }

    /* Convert block implementation
       Args: INFILE - filename (string), OUTNAME - name (without extension) to write to
       Returns: saved filename or data URL string if saving not possible
    */
    async convertPNG(args) {
        const inFile = args.INFILE;
        const outNameBase = args.OUTNAME || 'image-converted';

        const api = this._findFilesAPI();

        // Try to obtain base64 data for input file.
        let b64 = null;
        if (api && api.read) {
            try {
                // Some read functions return {data: 'base64...'} or raw base64 string. Handle both.
                const result = await api.read(inFile);
                if (!result) throw new Error('no data');
                if (typeof result === 'string') b64 = result;
                else if (typeof result === 'object') {
                    // common shape: {data: 'data:image/png;base64,...'} or {base64: '...'}
                    if (result.data) b64 = result.data;
                    else if (result.base64) b64 = result.base64;
                    else if (result.content) b64 = result.content;
                    else if (result.bytes) {
                        // bytes as Uint8Array -> convert to base64
                        const arr = result.bytes;
                        let binary = '';
                        for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
                        b64 = btoa(binary);
                    }
                }
            } catch (e) {
                // fallback: sometimes the files API exposes an object mapping
                try {
                    const maybeObj = api.files;
                    if (maybeObj && maybeObj[inFile]) b64 = maybeObj[inFile];
                } catch (e2) {}
            }
        }

        if (!b64) {
            // last resort: check global window.files (some embeddings)
            try {
                // eslint-disable-next-line no-undef
                if (typeof window !== 'undefined' && window.files && window.files[inFile]) b64 = window.files[inFile];
            } catch (e) {}
        }

        if (!b64) return `ERROR: no se pudo leer el archivo "${inFile}" con la extensión files disponible.`;

        // If the read string does not have data: prefix, add if necessary
        if (!b64.startsWith('data:')) b64 = 'data:image/png;base64,' + b64;

        const size = this._pngSizeFromBase64(b64);
        const svgStr = this._makeSvgString(b64, size ? size.width : null, size ? size.height : null);

        // Try to write using the files API
        if (api && api.write) {
            const outFilename = outNameBase.endsWith('.svg') ? outNameBase : (outNameBase + '.svg');
            try {
                // Some write functions expect (name, data) or an object
                const w = api.write;
                // Try common signatures
                try {
                    // If write returns a promise
                    const maybe = w(outFilename, svgStr);
                    if (maybe && typeof maybe.then === 'function') await maybe;
                } catch (e) {
                    // try save(outFilename, {data: svgStr})
                    if (typeof api.save === 'function') await api.save(outFilename, { data: svgStr });
                }

                return outFilename; // success
            } catch (e) {
                // can't write, will fall through to return data URL
            }
        }

        // As a fallback, return the SVG as a data URL string
        const svgBase64 = btoa(unescape(encodeURIComponent(svgStr)));
        return 'data:image/svg+xml;base64,' + svgBase64;
    }
}

// Export for Scratch/TurboWarp runtime to find
(function() {
    if (typeof window === 'undefined') return;
    // Register extension: Scratch VM and TurboWarp common convention
    if (window.vm && window.vm.extensionManager && typeof window.vm.extensionManager._registerExtension === 'function') {
        try {
            window.vm.extensionManager._registerExtension('pngToSvg', new PNGtoSVGExtension(window.vm.runtime));
        } catch (e) {
            // ignore
        }
    }
    // Also expose for extension loader that expects a function returning the class
    if (typeof window._registerScratchExtension === 'function') {
        try {
            window._registerScratchExtension('pngToSvg', PNGtoSVGExtension);
        } catch (e) {}
    }
    // Provide a global for manual registration
    window.PNGtoSVGExtension = PNGtoSVGExtension;
})();
