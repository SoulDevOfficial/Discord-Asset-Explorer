(() => {
    "use strict";

    const EXTENSIONS = {
        images: new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "svg", "ico"]),
        videos: new Set(["mp4", "webm"]),
        audios: new Set(["mp3", "ogg", "wav"]),
        fonts: new Set(["woff", "woff2", "ttf", "otf"]),
        others: new Set(["json", "wasm", "css", "js"])
    };
    const ALL_EXTENSIONS = new Set(Object.values(EXTENSIONS).flatMap(s => [...s]));

    const escapeHTML = s => String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[m]);

    const debounce = (fn, ms) => {
        let t;
        return (...args) => {
            clearTimeout(t);
            t = setTimeout(() => fn(...args), ms);
        };
    };

    const loadJSZip = () => window.JSZip ? Promise.resolve(window.JSZip) : new Promise((res, rej) => {
        if (document.querySelector('script[data-soul-jszip]')) return res(window.JSZip);
        const s = document.createElement("script");
        s.dataset.soulJszip = "1";
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
        s.onload = () => res(window.JSZip);
        s.onerror = () => rej(new Error("Failed to load JSZip"));
        document.head.appendChild(s);
    });

    class SoulAssetExplorer {
        constructor() {
            document.getElementById("__soul_asset_explorer__")?.remove();
            this.assets = new Map();
            this.pageSize = 80;
            this.visibleCount = this.pageSize;
            this.wreq = null;
            this.observer = null;
            this.activeAudio = null;
            this.activeSourceFilter = "all";
            this.prefs = this.loadPrefs();
            this.init();
        }

        loadPrefs() {
            try {
                return JSON.parse(localStorage.getItem("__soul_explorer_prefs__")) || { bgMode: "checker" };
            } catch {
                return { bgMode: "checker" };
            }
        }

        savePrefs() {
            try {
                localStorage.setItem("__soul_explorer_prefs__", JSON.stringify(this.prefs));
            } catch {}
        }

        init() {
            this.hookWebpack();
            this.extractFromWebpack();
            this.extractFromPerformance();
            this.extractFromDOM();
            this.extractFromCSS();
            this.assetList = this.buildAssetList();
            this.exportGlobals();
            this.renderUI();
        }

        hookWebpack() {
            if (typeof webpackChunkdiscord_app === "undefined") return;
            this.wreq = webpackChunkdiscord_app.push([[Symbol("soul_ext")], {}, r => r]);
            webpackChunkdiscord_app.pop();
        }

        getExtension(url) {
            try {
                const c = String(url).split(/[?#]/)[0];
                return c.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() ?? "";
            } catch {
                return "";
            }
        }

        normalizeURL(raw) {
            if (!raw) return null;
            let url = String(raw).replace(/\\(\/|u002F)/g, "/").trim().replace(/^["'`]|["'`]$/g, "");
            if (url.startsWith("data:") || url.startsWith("blob:")) return url;
            if (/^https?:\/\//i.test(url)) return url;
            try {
                if (url.startsWith("//")) return location.protocol + url;
                if (url.startsWith("/")) return new URL(url, location.origin).href;
                if (url.startsWith("assets/")) return new URL("/" + url, location.origin).href;
                if (/^[a-f0-9]{8,}\.[a-z0-9]+$/i.test(url)) return new URL("/assets/" + url, location.origin).href;
                if (this.wreq?.p) return new URL(url, this.wreq.p).href;
            } catch {}
            return null;
        }

        addAsset(raw, source, moduleId = null) {
            const url = this.normalizeURL(raw);
            if (!url) return;
            const extension = this.getExtension(url);
            if (!ALL_EXTENSIONS.has(extension) && !url.startsWith("data:") && !url.startsWith("blob:")) return;
            let item = this.assets.get(url);
            if (!item) {
                const fileName = url.split("/").pop().split("?")[0] || url;
                item = { url, extension, fileName, sources: new Set(), modules: new Set(), dimensions: null };
                this.assets.set(url, item);
            }
            item.sources.add(source);
            if (moduleId != null) item.modules.add(String(moduleId));
        }

        extractFromWebpack() {
            if (!this.wreq?.m) return;
            const extPattern = [...ALL_EXTENSIONS].join("|");
            const assetRegex = new RegExp("(?:https?:\\/\\/[^\"'\\\\\\s\\)]+|\\/?assets\\/[^\"'\\\\\\s\\)]+|[a-f0-9]{8,}\\.(?:" + extPattern + "))", "gi");
            for (const [mId, fn] of Object.entries(this.wreq.m)) {
                try {
                    const src = fn.toString();
                    let m;
                    while ((m = assetRegex.exec(src)) !== null) this.addAsset(m[0], "webpack", mId);
                } catch {}
            }
        }

        extractFromPerformance() {
            try {
                performance.getEntriesByType("resource").forEach(e => this.addAsset(e.name, "performance"));
            } catch {}
        }

        extractFromDOM() {
            document.querySelectorAll("img, video, audio, source, link, script").forEach(el => {
                ["src", "href", "poster"].forEach(a => {
                    const v = el.getAttribute(a);
                    if (v) this.addAsset(v, "dom:" + el.tagName.toLowerCase());
                });
            });
        }

        extractFromCSS() {
            const regex = /url\(["']?([^"')]+)["']?\)/g;
            for (const sheet of [...document.styleSheets]) {
                try {
                    if (sheet.ownerNode?.textContent) {
                        let m;
                        while ((m = regex.exec(sheet.ownerNode.textContent)) !== null) this.addAsset(m[1], "css");
                    }
                } catch {}
            }
        }

        buildAssetList() {
            return [...this.assets.values()].map(i => ({
                url: i.url,
                extension: i.extension,
                fileName: i.fileName,
                sources: [...i.sources],
                modules: [...i.modules],
                dimensions: i.dimensions,
                searchStr: `${i.url} ${i.extension} ${[...i.modules].join(" ")} ${[...i.sources].join(" ")}`.toLowerCase()
            })).sort((a, b) => a.extension.localeCompare(b.extension) || a.url.localeCompare(b.url));
        }

        exportGlobals() {
            window.__SOUL_DISCORD_ASSETS__ = this.assetList;
            window.__copySoulAssets = () => this.copyToClipboard(JSON.stringify(this.assetList, null, 2));
            window.__inspectSoulModule = m => this.inspectWebpackModule(m);
        }

        inspectWebpackModule(mId) {
            if (!this.wreq?.m?.[mId]) return console.warn(`[Soul] Webpack module ${mId} not found.`);
            console.group(`%c[Soul] Webpack Module: ${mId}`, "color:#a855f7;font-weight:bold");
            console.log(this.wreq.m[mId].toString());
            console.groupEnd();
        }

        async copyToClipboard(txt) {
            try {
                if (navigator.clipboard && window.isSecureContext) return await navigator.clipboard.writeText(txt);
            } catch {}
            const ta = document.createElement("textarea");
            ta.value = txt;
            ta.style.cssText = "position:fixed;left:-9999px";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try {
                document.execCommand("copy");
            } finally {
                ta.remove();
            }
        }

        renderUI() {
            this.root = document.createElement("div");
            this.root.id = "__soul_asset_explorer__";
            this.root.innerHTML = this.getHTMLTemplate();
            document.body.appendChild(this.root);
            this.cacheDOM();
            this.setupObserver();
            this.bindEvents();
            this.populateFilters();
            this.updateGrid();
        }

        setupObserver() {
            this.observer = new IntersectionObserver((entries, obs) => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        const img = e.target;
                        if (img.dataset.src) {
                            img.src = img.dataset.src;
                            delete img.dataset.src;
                        }
                        obs.unobserve(img);
                    }
                });
            }, { root: this.root.querySelector(".soul-body"), rootMargin: "150px" });
        }

        getHTMLTemplate() {
            return `<style>
                :root { --soul-bg: #111214; --soul-card: #1e1f22; --soul-text: #dbdee1; --soul-muted: #949ba4; --soul-accent: #a855f7; --soul-border: #2b2d31; }
                #__soul_asset_explorer__ { position: fixed; inset: 0; z-index: 2147483647; font-family: "gg sans", Whitney, sans-serif; color: var(--soul-text); }
                #__soul_asset_explorer__ * { box-sizing: border-box; }
                #__soul_asset_explorer__ ::-webkit-scrollbar { width: 8px; }
                #__soul_asset_explorer__ ::-webkit-scrollbar-track { background: var(--soul-bg); }
                #__soul_asset_explorer__ ::-webkit-scrollbar-thumb { background: #2b2d31; border-radius: 4px; }
                .soul-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.75); display: flex; justify-content: center; align-items: center; padding: 20px; }
                .soul-modal { width: min(1400px, 96vw); height: min(900px, 92vh); background: var(--soul-bg); border: 1px solid var(--soul-border); border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; }
                .soul-header { padding: 14px 18px; border-bottom: 1px solid var(--soul-border); display: flex; align-items: center; gap: 12px; background: #18191c; }
                .soul-heading { flex: 1; }
                .soul-heading h2 { margin: 0; font-size: 17px; color: #fff; font-weight: 700; }
                .soul-heading p { margin: 2px 0 0; font-size: 11px; color: var(--soul-muted); }
                .soul-header-actions { display: flex; align-items: center; gap: 8px; }
                .soul-icon-btn { border: 1px solid var(--soul-border); background: #2b2d31; color: var(--soul-text); border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; text-decoration: none; display: flex; align-items: center; gap: 6px; transition: background .15s; }
                .soul-icon-btn:hover { background: #35373c; color: #fff; }
                .soul-close { border: 0; width: 32px; height: 32px; border-radius: 6px; background: transparent; color: var(--soul-muted); font-size: 20px; cursor: pointer; }
                .soul-close:hover { background: #f23f42; color: #fff; }
                .soul-toolbar { padding: 10px 18px; display: flex; flex-wrap: wrap; gap: 10px; border-bottom: 1px solid var(--soul-border); background: #111214; align-items: center; }
                .soul-input { height: 36px; border: 1px solid var(--soul-border); background: var(--soul-card); color: var(--soul-text); border-radius: 6px; padding: 0 10px; outline: 0; font-size: 12px; }
                .soul-search { flex: 1; min-width: 200px; }
                .soul-input:focus { border-color: var(--soul-accent); }
                .soul-pills { display: flex; gap: 4px; border: 1px solid var(--soul-border); border-radius: 6px; padding: 2px; background: var(--soul-card); }
                .soul-pill { border: 0; background: transparent; color: var(--soul-muted); padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; cursor: pointer; }
                .soul-pill.active { background: var(--soul-accent); color: #fff; }
                .soul-info { display: flex; align-items: center; justify-content: flex-end; min-width: 90px; font-size: 12px; font-weight: 600; color: var(--soul-accent); margin-left: auto; }
                .soul-body { flex: 1; overflow-y: auto; padding: 16px; background: #141517; contain: content; }
                .soul-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
                .soul-card { background: var(--soul-card); border: 1px solid var(--soul-border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; contain: content; }
                .soul-card:hover { border-color: var(--soul-accent); }
                .soul-preview { height: 135px; display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden; position: relative; transition: background .15s; }
                .soul-preview.bg-checker { background: repeating-conic-gradient(#17181a 0% 25%, #1b1c1f 0% 50%) 50% / 16px 16px; }
                .soul-preview.bg-dark { background: #0e0f10; }
                .soul-preview.bg-light { background: #e3e5e8; }
                .soul-preview img, .soul-preview video { max-width: 100%; max-height: 100%; object-fit: contain; }
                .soul-dim-badge { position: absolute; bottom: 6px; right: 6px; background: rgba(0,0,0,.75); color: #fff; font-size: 9px; padding: 2px 5px; border-radius: 3px; font-family: monospace; }
                .soul-icon { font-size: 20px; color: var(--soul-muted); font-weight: 700; }
                .soul-audio-player { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 100%; padding: 10px; }
                .soul-audio-btn { width: 44px; height: 44px; border-radius: 50%; border: 0; background: var(--soul-accent); color: #fff; font-size: 12px; cursor: pointer; display: grid; place-items: center; }
                .soul-audio-btn:hover { opacity: .9; }
                .soul-card-body { padding: 10px; flex: 1; display: flex; flex-direction: column; }
                .soul-type { align-self: flex-start; padding: 2px 6px; border-radius: 4px; background: rgba(168,85,247,.15); color: #d8b4fe; font-size: 9px; text-transform: uppercase; font-weight: 700; }
                .soul-name { margin-top: 6px; font-family: monospace; font-size: 11px; color: var(--soul-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .soul-meta { margin-top: auto; padding-top: 6px; font-size: 10px; color: var(--soul-muted); line-height: 1.4; }
                .soul-mod-badge { color: var(--soul-accent); cursor: pointer; text-decoration: underline; }
                .soul-mod-badge:hover { color: #d8b4fe; }
                .soul-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
                .soul-btn { flex: 1; border: 1px solid var(--soul-border); border-radius: 4px; height: 28px; color: var(--soul-text); background: #2b2d31; cursor: pointer; font-size: 11px; font-weight: 500; white-space: nowrap; }
                .soul-btn:hover { background: #35373c; color: #fff; }
                .soul-btn-primary { background: var(--soul-accent); color: #fff; border: 0; margin: 16px auto 8px; display: block; padding: 8px 24px; border-radius: 6px; font-weight: 600; cursor: pointer; }
                .soul-btn-primary:hover { opacity: .9; }
            </style>
            <div class="soul-backdrop">
                <div class="soul-modal">
                    <div class="soul-header">
                        <div class="soul-heading">
                            <h2>Soul's Discord Asset Explorer</h2>
                        </div>
                        <div class="soul-header-actions">
                            <button class="soul-icon-btn soul-export-txt">Export Links (.txt)</button>
                            <button class="soul-icon-btn soul-export-zip">Download ZIP</button>
                            <button class="soul-icon-btn soul-copy-all">Copy JSON</button>
                            <a href="https://github.com/SoulDevOfficial/discord-asset-explorer" target="_blank" rel="noopener noreferrer" class="soul-icon-btn">GitHub</a>
                            <button class="soul-close" title="Close">×</button>
                        </div>
                    </div>
                    <div class="soul-toolbar">
                        <input class="soul-input soul-search" placeholder="Filter by name, hash, extension... (Press '/' to focus)" spellcheck="false">
                        <select class="soul-input soul-filter"><option value="">All Extensions</option></select>
                        <div class="soul-pills soul-source-pills">
                            <button class="soul-pill active" data-source="all">All</button>
                            <button class="soul-pill" data-source="webpack">Webpack</button>
                            <button class="soul-pill" data-source="dom">DOM</button>
                            <button class="soul-pill" data-source="performance">Perf</button>
                            <button class="soul-pill" data-source="css">CSS</button>
                        </div>
                        <button class="soul-icon-btn soul-bg-toggle" title="Toggle Background Style">BG Style</button>
                        <div class="soul-info">0 Assets</div>
                    </div>
                    <div class="soul-body">
                        <div class="soul-grid"></div>
                        <button class="soul-btn soul-btn-primary soul-load-more" style="display:none">Load More</button>
                    </div>
                </div>
            </div>`;
        }

        cacheDOM() {
            this.$grid = this.root.querySelector(".soul-grid");
            this.$search = this.root.querySelector(".soul-search");
            this.$filter = this.root.querySelector(".soul-filter");
            this.$info = this.root.querySelector(".soul-info");
            this.$loadMore = this.root.querySelector(".soul-load-more");
            this.$close = this.root.querySelector(".soul-close");
            this.$backdrop = this.root.querySelector(".soul-backdrop");
            this.$copyAll = this.root.querySelector(".soul-copy-all");
            this.$exportTxt = this.root.querySelector(".soul-export-txt");
            this.$exportZip = this.root.querySelector(".soul-export-zip");
            this.$bgToggle = this.root.querySelector(".soul-bg-toggle");
            this.$sourcePills = this.root.querySelector(".soul-source-pills");
        }

        bindEvents() {
            this.$search.addEventListener("input", debounce(() => {
                this.visibleCount = this.pageSize;
                this.updateGrid();
            }, 180));

            this.$filter.addEventListener("change", () => {
                this.visibleCount = this.pageSize;
                this.updateGrid();
            });

            this.$sourcePills.addEventListener("click", e => {
                const p = e.target.closest(".soul-pill");
                if (!p) return;
                this.$sourcePills.querySelectorAll(".soul-pill").forEach(el => el.classList.remove("active"));
                p.classList.add("active");
                this.activeSourceFilter = p.dataset.source;
                this.visibleCount = this.pageSize;
                this.updateGrid();
            });

            this.$bgToggle.addEventListener("click", () => {
                const modes = ["checker", "dark", "light"];
                this.prefs.bgMode = modes[(modes.indexOf(this.prefs.bgMode || "checker") + 1) % modes.length];
                this.savePrefs();
                this.root.querySelectorAll(".soul-preview").forEach(p => p.className = `soul-preview bg-${this.prefs.bgMode}`);
            });

            this.$loadMore.addEventListener("click", () => {
                this.visibleCount += this.pageSize;
                this.updateGrid();
            });

            this.$copyAll.addEventListener("click", async () => {
                await this.copyToClipboard(JSON.stringify(this.assetList, null, 2));
                const orig = this.$copyAll.textContent;
                this.$copyAll.textContent = "Copied!";
                setTimeout(() => this.$copyAll.textContent = orig, 1500);
            });

            this.$exportTxt.addEventListener("click", () => {
                const text = this.getFilteredAssets().map(a => a.url).join("\n");
                const blob = new Blob([text], { type: "text/plain" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `discord-assets-${Date.now()}.txt`;
                a.click();
                URL.revokeObjectURL(a.href);
            });

            this.$exportZip.addEventListener("click", async () => {
                const orig = this.$exportZip.textContent;
                this.$exportZip.textContent = "Loading JSZip...";
                try {
                    const JSZip = await loadJSZip();
                    const zip = new JSZip();
                    const filtered = this.getFilteredAssets();
                    if (!filtered.length) {
                        alert("No assets to download.");
                        return;
                    }
                    if (filtered.length > 300 && !confirm(`Fetch ${filtered.length} assets?`)) return;
                    let count = 0;
                    this.$exportZip.textContent = `Fetching (0/${filtered.length})...`;
                    await Promise.all(filtered.map(async (a, i) => {
                        try {
                            const res = await fetch(a.url);
                            const blob = await res.blob();
                            const name = a.url.split("/").pop().split("?")[0] || `asset_${i}.${a.extension || "bin"}`;
                            zip.file(name, blob);
                        } catch {} finally {
                            count++;
                            this.$exportZip.textContent = `Fetching (${count}/${filtered.length})...`;
                        }
                    }));
                    this.$exportZip.textContent = "Compressing...";
                    const content = await zip.generateAsync({ type: "blob" });
                    const el = document.createElement("a");
                    el.href = URL.createObjectURL(content);
                    el.download = `soul-assets-${Date.now()}.zip`;
                    el.click();
                    URL.revokeObjectURL(el.href);
                } catch (e) {
                    console.error("[Soul] ZIP Export error:", e);
                    alert("Error creating ZIP file.");
                } finally {
                    this.$exportZip.textContent = orig;
                }
            });

            this.$grid.addEventListener("click", async e => {
                const btn = e.target.closest(".soul-btn");
                const mod = e.target.closest(".soul-mod-badge");
                if (mod?.dataset.mod) return this.inspectWebpackModule(mod.dataset.mod);
                if (!btn) return;
                if (btn.dataset.copy) {
                    await this.copyToClipboard(btn.dataset.copy);
                    const orig = btn.textContent;
                    btn.textContent = "Copied!";
                    btn.style.background = "#23a559";
                    setTimeout(() => {
                        btn.textContent = orig;
                        btn.style.background = "";
                    }, 1500);
                } else if (btn.dataset.open) {
                    window.open(btn.dataset.open, "_blank", "noopener,noreferrer");
                } else if (btn.dataset.copySvg) {
                    btn.textContent = "Fetching...";
                    try {
                        const r = await fetch(btn.dataset.copySvg);
                        const svg = await r.text();
                        await this.copyToClipboard(svg);
                        btn.textContent = "Copied SVG!";
                        btn.style.background = "#23a559";
                        setTimeout(() => {
                            btn.textContent = "Copy SVG Code";
                            btn.style.background = "";
                        }, 1500);
                    } catch {
                        btn.textContent = "Failed!";
                        setTimeout(() => btn.textContent = "Copy SVG Code", 1500);
                    }
                } else if (btn.dataset.playAudio) {
                    const url = btn.dataset.playAudio;
                    if (this.activeAudio) {
                        this.activeAudio.pause();
                        if (this.activeAudio.src === url) {
                            this.activeAudio = null;
                            btn.textContent = "Play Sound";
                            return;
                        }
                    }
                    this.root.querySelectorAll("[data-play-audio]").forEach(b => b.textContent = "Play Sound");
                    const audio = new Audio(url);
                    audio.play().catch(() => {});
                    btn.textContent = "Pause";
                    this.activeAudio = audio;
                    audio.onended = () => {
                        btn.textContent = "Play Sound";
                        this.activeAudio = null;
                    };
                }
            });

            this.handleKeyDown = e => {
                if (e.key === "Escape") this.destroy();
                else if (e.key === "/" && document.activeElement !== this.$search) {
                    e.preventDefault();
                    this.$search.focus();
                }
            };

            document.addEventListener("keydown", this.handleKeyDown);
            this.$close.addEventListener("click", () => this.destroy());
            this.$backdrop.addEventListener("click", e => {
                if (e.target === this.$backdrop) this.destroy();
            });
        }

        populateFilters() {
            const exts = [...new Set(this.assetList.map(a => a.extension).filter(Boolean))].sort();
            const frag = document.createDocumentFragment();
            exts.forEach(ext => {
                const opt = document.createElement("option");
                opt.value = ext;
                opt.textContent = ext.toUpperCase();
                frag.appendChild(opt);
            });
            this.$filter.appendChild(frag);
        }

        getFilteredAssets() {
            const query = this.$search.value.trim().toLowerCase();
            const filterExt = this.$filter.value;
            const sourceFilter = this.activeSourceFilter;
            return this.assetList.filter(a => {
                if (filterExt && a.extension !== filterExt) return false;
                if (sourceFilter !== "all" && !a.sources.some(s => s.toLowerCase().startsWith(sourceFilter))) return false;
                return !query || a.searchStr.includes(query);
            });
        }

        createCardNode(asset) {
            const card = document.createElement("div");
            card.className = "soul-card";
            const url = escapeHTML(asset.url);
            const ext = asset.extension;
            const fileName = escapeHTML(asset.fileName);
            const modsFormatted = asset.modules.length ? asset.modules.slice(0, 3).map(m => `<span class="soul-mod-badge" data-mod="${escapeHTML(m)}">${escapeHTML(m)}</span>`).join(", ") + (asset.modules.length > 3 ? "..." : "") : "N/A";
            let preview = "";
            let extraBtns = "";
            const bg = `bg-${this.prefs.bgMode || "checker"}`;
            if (EXTENSIONS.images.has(ext)) {
                preview = `<img data-src="${url}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=\\'soul-icon\\'>Error</div>'"><span class="soul-dim-badge" style="display:none"></span>`;
                if (ext === "svg") extraBtns += `<button class="soul-btn" data-copy-svg="${url}">Copy SVG Code</button>`;
            } else if (EXTENSIONS.videos.has(ext)) {
                preview = `<video src="${url}" controls preload="metadata"></video>`;
            } else if (EXTENSIONS.audios.has(ext)) {
                preview = `<div class="soul-audio-player"><button class="soul-audio-btn soul-btn" data-play-audio="${url}">Play</button><span style="font-size: 11px; color: var(--soul-muted)">Audio Clip</span></div>`;
                extraBtns += `<button class="soul-btn" data-play-audio="${url}">Play Sound</button>`;
            } else if (EXTENSIONS.fonts.has(ext)) {
                preview = `<div class="soul-icon" style="font-family: serif;">Aa</div>`;
            } else {
                preview = `<div class="soul-icon">.${escapeHTML(ext || "?")}</div>`;
            }
            card.innerHTML = `<div class="soul-preview ${bg}">${preview}</div><div class="soul-card-body"><span class="soul-type">${escapeHTML(ext || "unknown")}</span><div class="soul-name" title="${url}">${fileName}</div><div class="soul-meta"><strong>Mods:</strong> ${modsFormatted}<br><strong>Source:</strong> ${escapeHTML(asset.sources.join(", "))}</div><div class="soul-actions"><button class="soul-btn" data-copy="${url}">Copy URL</button><button class="soul-btn" data-open="${url}">Open</button>${extraBtns}</div></div>`;
            const img = card.querySelector("img[data-src]");
            if (img) {
                img.onload = () => {
                    const badge = card.querySelector(".soul-dim-badge");
                    if (badge && img.naturalWidth) {
                        badge.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
                        badge.style.display = "block";
                    }
                };
                this.observer.observe(img);
            }
            return card;
        }

        updateGrid() {
            const filtered = this.getFilteredAssets();
            const visible = filtered.slice(0, this.visibleCount);
            this.$info.textContent = `${filtered.length} Found`;
            this.observer.disconnect();
            const frag = document.createDocumentFragment();
            visible.forEach(a => frag.appendChild(this.createCardNode(a)));
            this.$grid.innerHTML = "";
            this.$grid.appendChild(frag);
            this.$loadMore.style.display = filtered.length > this.visibleCount ? "block" : "none";
        }

        destroy() {
            document.removeEventListener("keydown", this.handleKeyDown);
            this.observer?.disconnect();
            this.activeAudio?.pause();
            this.root.querySelectorAll("video, audio").forEach(m => m.pause());
            this.root.remove();
        }
    }

    window.openSoulExplorer = () => new SoulAssetExplorer();
    window.openSoulExplorer();
})();
