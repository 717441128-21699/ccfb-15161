// 会话状态 + 本地持久化(登记表 / 归档记录)
export const session = {
    tapeId: null,
    fileName: null,
    sampleRate: 44100,
    origL: null,
    origR: null,
    result: null,
};
const REG_KEY = 'tapeRescue.registry';
const ARC_KEY = 'tapeRescue.archive';
function load(key) {
    try {
        return JSON.parse(localStorage.getItem(key) ?? '[]');
    }
    catch {
        return [];
    }
}
function save(key, rows) {
    localStorage.setItem(key, JSON.stringify(rows));
}
export const registry = {
    list() { return load(REG_KEY); },
    add(rec) { const r = registry.list(); r.push(rec); save(REG_KEY, r); },
    get(id) { return registry.list().find((t) => t.id === id); },
    remove(id) { save(REG_KEY, registry.list().filter((t) => t.id !== id)); },
};
export const archive = {
    list() { return load(ARC_KEY); },
    add(rec) { const r = archive.list(); r.push(rec); save(ARC_KEY, r); },
    remove(id) { save(ARC_KEY, archive.list().filter((t) => t.id !== id)); },
};
export function uid() {
    return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
