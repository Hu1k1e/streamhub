const SUPPORTED_EXTS = new Set(['mp4', 'm4v', 'mkv', 'webm', 'avi', 'ts', 'mov', 'm2ts', 'mpeg', 'mpg']);
const EXCLUDED_KEYWORDS = /\b(sample|trailer|extras?|featurettes?|bonus|behind.the.scenes|interview|deleted|scene)\b/i;
const MIN_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * @param {import('webtorrent').TorrentFile[]} files
 * @returns {import('webtorrent').TorrentFile | null}
 */
export function selectBestFile(files) {
    if (!files || files.length === 0) return null;

    const candidates = files.filter(f => {
        const name = f.name.toLowerCase();
        const ext = name.split('.').pop();
        if (!SUPPORTED_EXTS.has(ext)) return false;
        if (f.length < MIN_SIZE_BYTES) return false;
        if (EXCLUDED_KEYWORDS.test(name)) return false;
        return true;
    });

    if (candidates.length === 0) {
        // Relaxed fallback: largest supported-extension file
        const anyVideo = files
            .filter(f => SUPPORTED_EXTS.has(f.name.toLowerCase().split('.').pop()))
            .sort((a, b) => b.length - a.length);
        return anyVideo[0] || null;
    }

    return candidates.reduce((best, f) => f.length > best.length ? f : best, candidates[0]);
}
