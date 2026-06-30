// ==UserScript==
// @name         98堂搜索助手
// @namespace    local.discuz.resource.collector
// @version      0.1.0
// @description  搜索页无缝翻页、板块白名单过滤、自动滚动、资源收纳和带标题复制。
// @author       local
// @match        *://*.sehuatang.net/*
// @match        *://*.sehuatang.org/*
// @match        *://*.dmn12.vip/*
// @noframes
// @connect      *
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window.self || !document.body) return;

    const SCRIPT_ID = 'drc';
    const STORAGE_PREFIX = 'drc_v1_';
    const CACHE_DB_NAME = 'HT98_Search_Assistant_Cache';
    const CACHE_STORE_NAME = 'threads';
    const CACHE_TTL = 2 * 24 * 60 * 60 * 1000;
    const isSearchPage = location.pathname.includes('search.php');
    const hasThreadList = Boolean(document.querySelector('#threadlist, #threadlisttableid'));

    if (!isSearchPage && !hasThreadList) return;

    const defaultSettings = {
        seamless: true,
        scrollIntervalSec: 5,
        extractIntervalSec: 1,
        maxPageLoads: 10,
        whitelistForums: [],
        keepTitleKeywords: [],
        keepUsers: [],
        keepTitleMode: 'or',
        poolCopyMode: 'detail',
        blockedForums: [],
        blockedTags: [],
        blockedKeywords: [],
        blockedUsers: [],
        highlightKeywords: []
    };

    const state = {
        settings: loadSettings(),
        pool: loadPool(),
        logs: [],
        nextPageUrl: findNextPageUrl(document),
        loadingNextPage: false,
        loadedPageCount: 0,
        autoScrollTimer: null,
        extractRunning: false,
        extractStopRequested: false,
        totalCount: 0,
        hiddenCount: 0,
        remainingCount: 0,
        threadCache: {},
        processedLinks: new Set(),
        loggedKeys: new Set()
    };

    function loadSettings() {
        const saved = GM_getValue(STORAGE_PREFIX + 'settings', {});
        return Object.assign({}, defaultSettings, normalizeSettings(saved));
    }

    function normalizeSettings(settings) {
        const next = Object.assign({}, settings || {});
        [
            'whitelistForums',
            'keepTitleKeywords',
            'keepUsers',
            'blockedForums',
            'blockedTags',
            'blockedKeywords',
            'blockedUsers',
            'highlightKeywords'
        ].forEach((key) => {
            next[key] = normalizeStringList(next[key]);
        });
        next.scrollIntervalSec = Math.max(3, Number(next.scrollIntervalSec || defaultSettings.scrollIntervalSec));
        next.extractIntervalSec = Math.max(1, Number(next.extractIntervalSec || defaultSettings.extractIntervalSec));
        next.maxPageLoads = Math.max(0, Number(next.maxPageLoads || defaultSettings.maxPageLoads));
        next.seamless = Boolean(next.seamless);
        next.keepTitleMode = next.keepTitleMode === 'and' ? 'and' : 'or';
        next.poolCopyMode = next.poolCopyMode === 'plain' ? 'plain' : 'detail';
        return next;
    }

    function normalizeStringList(value) {
        if (!Array.isArray(value)) return [];
        return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
    }

    function saveSettings() {
        GM_setValue(STORAGE_PREFIX + 'settings', state.settings);
    }

    function loadPool() {
        const saved = GM_getValue(STORAGE_PREFIX + 'pool', []);
        if (!Array.isArray(saved)) return [];
        return saved
            .filter((item) => item && item.title && Array.isArray(item.links))
            .map((item) => Object.assign({}, item, {
                links: normalizeStringList(item.links),
                torrents: Array.isArray(item.torrents) ? item.torrents.filter((torrent) => torrent && torrent.href) : []
            }));
    }

    function savePool() {
        GM_setValue(STORAGE_PREFIX + 'pool', state.pool);
    }

    function textOf(node) {
        return (node ? node.textContent : '').replace(/\s+/g, ' ').trim();
    }

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, '').toLowerCase();
    }

    function normalizeExactText(value) {
        return normalizeText(String(value || '').replace(/^[\[\【]+|[\]\】]+$/g, ''));
    }

    function exactListMatches(list, value) {
        const source = normalizeExactText(value);
        if (!source) return false;
        return list.some((item) => {
            const rule = normalizeExactText(item);
            return rule && source === rule;
        });
    }

    function containsListMatches(list, value) {
        const source = normalizeText(value);
        if (!source) return false;
        return list.some((item) => {
            const rule = normalizeText(item);
            return rule && source.includes(rule);
        });
    }

    function titleKeepMatches(list, mode, title) {
        const keywords = normalizeStringList(list);
        if (keywords.length === 0) return true;

        const source = normalizeText(title);
        if (!source) return false;

        const hits = keywords.map((keyword) => source.includes(normalizeText(keyword)));
        return mode === 'and' ? hits.every(Boolean) : hits.some(Boolean);
    }

    function userRuleMatches(list, name, uid) {
        const rules = normalizeStringList(list);
        if (rules.length === 0) return false;
        return rules.some((rule) => exactListMatches([rule], name) || exactListMatches([rule], uid));
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function rawHref(link) {
        return link ? (link.getAttribute('href') || link.href || '') : '';
    }

    function absoluteHref(link) {
        const href = rawHref(link);
        return href ? new URL(href, location.href).href : '';
    }

    function getTid(url) {
        const value = String(url || '');
        let match = value.match(/tid=(\d+)/);
        if (match) return match[1];
        match = value.match(/thread-(\d+)/);
        if (match) return match[1];
        return value;
    }

    const CacheDB = {
        db: null,
        ready: null,
        init() {
            if (this.ready) return this.ready;
            this.ready = new Promise((resolve) => {
                if (!window.indexedDB) {
                    resolve();
                    return;
                }
                const request = indexedDB.open(CACHE_DB_NAME, 1);
                const fallbackTimer = window.setTimeout(() => resolve(), 1500);
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
                        db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'key' });
                    }
                };
                request.onsuccess = (event) => {
                    window.clearTimeout(fallbackTimer);
                    this.db = event.target.result;
                    this.clean();
                    resolve();
                };
                request.onerror = () => {
                    window.clearTimeout(fallbackTimer);
                    resolve();
                };
                request.onblocked = () => {
                    window.clearTimeout(fallbackTimer);
                    resolve();
                };
            });
            return this.ready;
        },
        async ensureReady() {
            if (this.ready) await this.ready;
        },
        async get(key) {
            await this.ensureReady();
            if (!this.db || !key) return null;
            return new Promise((resolve) => {
                const tx = this.db.transaction(CACHE_STORE_NAME, 'readonly');
                const request = tx.objectStore(CACHE_STORE_NAME).get(key);
                request.onsuccess = () => {
                    const result = request.result;
                    if (result && Date.now() - result.ts < CACHE_TTL) {
                        resolve(result.data);
                    } else {
                        if (result) this.delete(key);
                        resolve(null);
                    }
                };
                request.onerror = () => resolve(null);
            });
        },
        async set(key, data) {
            await this.ensureReady();
            if (!this.db || !key) return;
            return new Promise((resolve) => {
                const tx = this.db.transaction(CACHE_STORE_NAME, 'readwrite');
                tx.objectStore(CACHE_STORE_NAME).put({ key, data, ts: Date.now() });
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        },
        async delete(key) {
            await this.ensureReady();
            if (!this.db || !key) return;
            const tx = this.db.transaction(CACHE_STORE_NAME, 'readwrite');
            tx.objectStore(CACHE_STORE_NAME).delete(key);
        },
        async clean() {
            await this.ensureReady();
            if (!this.db) return 0;
            return new Promise((resolve) => {
                let removed = 0;
                const tx = this.db.transaction(CACHE_STORE_NAME, 'readwrite');
                const request = tx.objectStore(CACHE_STORE_NAME).openCursor();
                const now = Date.now();
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor) return;
                    if (now - cursor.value.ts >= CACHE_TTL) {
                        cursor.delete();
                        removed += 1;
                    }
                    cursor.continue();
                };
                tx.oncomplete = () => resolve(removed);
                tx.onerror = () => resolve(removed);
            });
        },
        async clear() {
            await this.ensureReady();
            state.threadCache = {};
            if (!this.db) return;
            return new Promise((resolve) => {
                const tx = this.db.transaction(CACHE_STORE_NAME, 'readwrite');
                tx.objectStore(CACHE_STORE_NAME).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        }
    };

    function addLog(message, detail) {
        const time = new Date().toLocaleTimeString();
        state.logs.unshift({ time, message, detail: detail || '' });
        state.logs = state.logs.slice(0, 120);
        updateLogUI();
    }

    function requestText(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'Cache-Control': 'no-cache',
                    Pragma: 'no-cache'
                },
                timeout: 15000,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 400) {
                        resolve(res.responseText || '');
                    } else {
                        reject(new Error('HTTP ' + res.status));
                    }
                },
                ontimeout: () => reject(new Error('请求超时')),
                onerror: () => reject(new Error('网络请求失败'))
            });
        });
    }

    function findNextPageUrl(doc) {
        const next = doc.querySelector('a.nxt');
        if (next && rawHref(next)) return absoluteHref(next);

        const candidates = Array.from(doc.querySelectorAll('a[href]'));
        const nextText = candidates.find((link) => /下一页|下页|next/i.test(textOf(link)));
        if (nextText && rawHref(nextText)) return absoluteHref(nextText);

        return '';
    }

    function getListContainer() {
        return document.querySelector('#threadlist ul') ||
            document.querySelector('#threadlisttableid') ||
            document.querySelector('#threadlist');
    }

    function getThreadItems(root) {
        const base = root || document;
        const items = Array.from(base.querySelectorAll('#threadlist li.pbw, #threadlist tbody[id^="normalthread_"], #threadlisttableid tbody[id^="normalthread_"]'));
        return items.filter((item) => {
            if (!item || item.id === 'separatorline') return false;
            if (item.querySelector && item.querySelector('th.common')) return false;
            return Boolean(findTitleLink(item));
        });
    }

    function findTitleLink(item) {
        const direct = item.querySelector('h3 a[href], a.xst[href], th a[href*="thread-"], th a[href*="viewthread"], th a[href*="tid="]');
        if (direct) return direct;

        return Array.from(item.querySelectorAll('a[href]')).find((link) => {
            const href = rawHref(link);
            return /thread-\d+|viewthread|tid=\d+/.test(href) && !/forumdisplay|fid=|forum-\d+/.test(href);
        }) || null;
    }

    function findForumName(item, titleLink) {
        const selectors = [
            'a[href*="fid="]',
            'a[href*="forumdisplay"]',
            'a[href*="forum-"]'
        ];

        for (const selector of selectors) {
            const link = Array.from(item.querySelectorAll(selector)).find((node) => {
                if (node === titleLink) return false;
                const href = rawHref(node);
                return !/thread-\d+|viewthread|tid=\d+/.test(href);
            });
            const name = textOf(link).replace(/^[\[\【]+|[\]\】]+$/g, '');
            if (name) return name;
        }

        return '';
    }

    function extractItemInfo(item) {
        const titleLink = findTitleLink(item);
        const title = titleLink ? (titleLink.dataset.drcOriginalTitle || textOf(titleLink)) : '';
        if (titleLink && !titleLink.dataset.drcOriginalTitle) titleLink.dataset.drcOriginalTitle = title;
        const forumName = findForumName(item, titleLink);

        const tagNode = item.querySelector('em a, .threadpre .xg1 a, a[href*="typeid="]');
        const tagName = textOf(tagNode).replace(/^[\[\【]+|[\]\】]+$/g, '');

        const authorNode = item.querySelector('a[href*="space-uid"], td.by cite a, .by a');
        const authorName = textOf(authorNode);
        let authorUid = '';
        if (authorNode) {
            const href = rawHref(authorNode);
            const uidMatch = href.match(/(?:space-uid-|uid=)(\d+)/);
            if (uidMatch) authorUid = uidMatch[1];
        }

        return {
            item,
            titleLink,
            title,
            url: absoluteHref(titleLink),
            forumName,
            tagName,
            authorName,
            authorUid
        };
    }

    function ensureCheckbox(info) {
        if (!info.titleLink || info.item.querySelector('.drc-thread-checkbox')) return;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'drc-thread-checkbox';
        checkbox.value = info.url;
        checkbox.title = '选择此帖';
        checkbox.dataset.title = info.title;
        checkbox.dataset.forum = info.forumName;
        checkbox.style.cssText = 'width:16px;height:16px;margin-right:8px;vertical-align:middle;cursor:pointer;';
        checkbox.addEventListener('change', updateOperationStatus);
        info.titleLink.parentNode.insertBefore(checkbox, info.titleLink);
    }

    function applyHighlight(info) {
        if (!info.titleLink || !info.title) return;
        const keywords = state.settings.highlightKeywords.filter(Boolean);
        if (keywords.length === 0) {
            info.titleLink.textContent = info.title;
            return;
        }

        let html = escapeHtml(info.title);
        keywords
            .slice()
            .sort((a, b) => b.length - a.length)
            .forEach((keyword) => {
                const reg = new RegExp('(' + escapeRegExp(escapeHtml(keyword)) + ')', 'gi');
                html = html.replace(reg, '<span class="drc-highlight">$1</span>');
            });
        info.titleLink.innerHTML = html;
    }

    function evaluateItem(info) {
        const settings = state.settings;
        let reason = '';

        if (settings.whitelistForums.length > 0 && !exactListMatches(settings.whitelistForums, info.forumName)) {
            reason = '非白名单版块：' + (info.forumName || '未知版块');
        } else if (!titleKeepMatches(settings.keepTitleKeywords, settings.keepTitleMode, info.title)) {
            reason = '标题未命中保留关键词：' + info.title;
        } else if (settings.keepUsers.length > 0 && !userRuleMatches(settings.keepUsers, info.authorName, info.authorUid)) {
            reason = '非保留用户：' + (info.authorName || info.authorUid || '未知用户');
        } else if (exactListMatches(settings.blockedForums, info.forumName)) {
            reason = '屏蔽版块：' + info.forumName;
        } else if (exactListMatches(settings.blockedTags, info.tagName)) {
            reason = '屏蔽分类/标签：' + info.tagName;
        } else if (containsListMatches(settings.blockedKeywords, info.title)) {
            reason = '屏蔽标题关键词：' + info.title;
        } else if (userRuleMatches(settings.blockedUsers, info.authorName, info.authorUid)) {
            reason = '屏蔽用户：' + (info.authorName || info.authorUid);
        }

        if (reason) {
            info.item.classList.add('drc-hidden');
            info.item.dataset.drcReason = reason;
            const cb = info.item.querySelector('.drc-thread-checkbox');
            if (cb) cb.checked = false;

            const key = (info.url || info.title) + '|' + reason;
            if (!state.loggedKeys.has(key)) {
                state.loggedKeys.add(key);
                addLog('已过滤', reason + ' | ' + (info.title || '无标题'));
            }
        } else {
            info.item.classList.remove('drc-hidden');
            info.item.dataset.drcReason = '';
            applyHighlight(info);
        }
    }

    function processPageItems() {
        const items = getThreadItems(document);
        let hidden = 0;

        items.forEach((item) => {
            const info = extractItemInfo(item);
            if (!info.url) return;
            state.processedLinks.add(info.url);
            ensureCheckbox(info);
            evaluateItem(info);
            if (item.classList.contains('drc-hidden')) hidden += 1;
        });

        state.totalCount = items.length;
        state.hiddenCount = hidden;
        state.remainingCount = Math.max(0, items.length - hidden);
        updateFilterTip(items.length, hidden);
        updateFloatBadge();
        updateOperationStatus();
    }

    function updateFilterTip(total, hidden) {
        const anchor = document.querySelector('.sttl') || document.querySelector('#threadlist') || document.querySelector('#threadlisttableid');
        if (!anchor || total === 0) return;

        let tip = document.getElementById('drc-filter-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'drc-filter-tip';
            anchor.parentNode.insertBefore(tip, anchor);
        }

        const whitelistText = state.settings.whitelistForums.length
            ? '白名单：' + state.settings.whitelistForums.join('、')
            : '白名单未启用';
        tip.textContent = '过滤状态：总条数 ' + total + ' 条，已过滤 ' + hidden + ' 条，剩余 ' + Math.max(0, total - hidden) + ' 条，' + whitelistText;
    }

    async function loadNextPage(reason, options = {}) {
        const enforceLimit = options.enforceLimit !== false;

        if (state.loadingNextPage) return false;
        if (!state.nextPageUrl) {
            stopAutoScroll();
            addLog('翻页停止', '没有找到下一页');
            return false;
        }

        if (enforceLimit && state.settings.maxPageLoads > 0 && state.loadedPageCount >= state.settings.maxPageLoads) {
            stopAutoScroll();
            addLog('翻页停止', '已达到设置次数 ' + state.settings.maxPageLoads);
            return false;
        }

        const container = getListContainer();
        if (!container) {
            addLog('翻页失败', '没有找到搜索结果容器');
            return false;
        }

        state.loadingNextPage = true;
        updateOperationStatus('正在加载下一页...');

        try {
            const currentUrls = new Set(getThreadItems(document).map((item) => extractItemInfo(item).url).filter(Boolean));
            const html = await requestText(state.nextPageUrl);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const newItems = getThreadItems(doc);
            let appended = 0;

            newItems.forEach((newItem) => {
                const info = extractItemInfo(newItem);
                if (!info.url || currentUrls.has(info.url)) return;
                currentUrls.add(info.url);
                container.appendChild(document.importNode(newItem, true));
                appended += 1;
            });

            state.nextPageUrl = findNextPageUrl(doc);
            state.loadedPageCount += 1;
            addLog('已加载下一页', '第 ' + state.loadedPageCount + ' 次，新增 ' + appended + ' 条' + (reason ? '，来源：' + reason : ''));
            processPageItems();

            if (!state.nextPageUrl) {
                stopAutoScroll();
                addLog('翻页停止', '已经没有下一页');
            }
            return appended > 0;
        } catch (error) {
            addLog('翻页失败', error.message);
            return false;
        } finally {
            state.loadingNextPage = false;
            updateOperationStatus();
        }
    }

    function startAutoScroll() {
        stopAutoScroll(false);
        state.settings.seamless = true;
        saveSettings();

        const intervalMs = Math.max(3, Number(state.settings.scrollIntervalSec || 5)) * 1000;
        state.autoScrollTimer = window.setInterval(() => {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            window.setTimeout(() => {
                if (isNearBottom()) loadNextPage('自动滚动');
            }, 700);
        }, intervalMs);

        addLog('自动滚动已启动', '间隔 ' + Math.round(intervalMs / 1000) + ' 秒');
        updateOperationStatus();
    }

    function stopAutoScroll(writeLog = true) {
        if (state.autoScrollTimer) {
            window.clearInterval(state.autoScrollTimer);
            state.autoScrollTimer = null;
            if (writeLog) addLog('自动滚动已停止', '');
        }
        updateOperationStatus();
    }

    function isNearBottom() {
        return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 900;
    }

    window.addEventListener('scroll', () => {
        if (!state.settings.seamless) return;
        if (isNearBottom()) loadNextPage('滑到底部');
    }, { passive: true });

    function getVisibleCheckboxes() {
        return Array.from(document.querySelectorAll('.drc-thread-checkbox')).filter((cb) => {
            const item = cb.closest('li.pbw, tbody');
            return item && !item.classList.contains('drc-hidden');
        });
    }

    function toggleSelectVisible() {
        const boxes = getVisibleCheckboxes();
        const shouldCheck = boxes.some((cb) => !cb.checked);
        boxes.forEach((cb) => {
            cb.checked = shouldCheck;
        });
        updateOperationStatus();
    }

    function decodeCloudflareEmail(doc) {
        doc.querySelectorAll('.__cf_email__').forEach((node) => {
            const code = node.getAttribute('data-cfemail');
            if (!code) return;
            let email = '';
            const key = parseInt(code.slice(0, 2), 16);
            for (let i = 2; i < code.length; i += 2) {
                email += String.fromCharCode(parseInt(code.slice(i, i + 2), 16) ^ key);
            }
            node.replaceWith(document.createTextNode(email));
        });
    }

    function extractResourcesFromText(text) {
        const cleanText = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
        const links = [];
        const magnetReg = /magnet:\?xt=urn:btih:[0-9a-zA-Z]{32,40}(?:&[^\s<>"'，。；、]*)?/gi;
        const hashReg = /(?:特征码|磁力|hash|哈希|链接|代码)[:：\s]*([0-9a-fA-F]{40})\b/gi;
        const ed2kReg = /ed2k:\/\/\|file\|[^|]+\|\d+\|[a-fA-F0-9]{32}\|.*?\//gi;
        let match;

        while ((match = magnetReg.exec(cleanText)) !== null) {
            links.push(match[0]);
        }
        while ((match = hashReg.exec(cleanText)) !== null) {
            links.push('magnet:?xt=urn:btih:' + match[1].toUpperCase());
        }
        while ((match = ed2kReg.exec(cleanText)) !== null) {
            links.push(match[0]);
        }

        return [...new Set(links)];
    }

    function extractMetaFromText(text) {
        const cleanText = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
        return {
            actress: extractField(cleanText, ['出演女优', '主演女优', '女优', '演员']),
            size: extractField(cleanText, ['影片容量', '文件大小', '影片大小', '容量', '大小'])
        };
    }

    function extractField(text, labels) {
        const sortedLabels = labels.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
        const reg = new RegExp('(?:【\\s*(?:' + sortedLabels + ')\\s*】|(?:' + sortedLabels + '))\\s*[：:]\\s*([^\\r\\n【】]+)', 'i');
        const match = reg.exec(text);
        return match ? match[1].replace(/\s+/g, ' ').trim() : '';
    }

    function extractTorrentsFromDoc(doc) {
        const torrents = [];
        doc.querySelectorAll('a[href]').forEach((link) => {
            const href = absoluteHref(link);
            const name = textOf(link) || link.getAttribute('title') || '下载附件';
            const lowerName = name.toLowerCase();
            const lowerHref = href.toLowerCase();
            const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)(?:$|\?)/i.test(lowerName + ' ' + lowerHref) || Boolean(link.querySelector('img'));
            const isTorrent = lowerName.includes('.torrent') || lowerName.includes('种子') || lowerHref.includes('mod=attachment') || lowerHref.includes('attachment.php');

            if (!isImage && isTorrent && !torrents.some((item) => item.href === href)) {
                torrents.push({ name, href });
            }
        });
        return torrents;
    }

    async function fetchThreadResources(url) {
        const cacheKey = getTid(url);
        if (state.threadCache[cacheKey]) {
            return Object.assign({}, state.threadCache[cacheKey], { fromCache: true });
        }

        const cached = await CacheDB.get(cacheKey);
        if (cached) {
            state.threadCache[cacheKey] = cached;
            return Object.assign({}, cached, { fromCache: true });
        }

        const html = await requestText(url);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        decodeCloudflareEmail(doc);

        const alertNode = doc.querySelector('.alert_error, .alert_info');
        if (alertNode) {
            return { links: [], torrents: [], actress: '', size: '', error: textOf(alertNode) };
        }

        const postNodes = Array.from(doc.querySelectorAll('#postlist > div[id^="post_"], td.t_f, .pcb'));
        const sourceNodes = postNodes.length ? postNodes : [doc.body];
        const text = sourceNodes.map((node) => node.innerText || node.textContent || '').join('\n');
        const meta = extractMetaFromText(text);
        const result = {
            links: extractResourcesFromText(text),
            torrents: extractTorrentsFromDoc(doc),
            actress: meta.actress,
            size: meta.size,
            error: ''
        };

        state.threadCache[cacheKey] = result;
        await CacheDB.set(cacheKey, result);
        return result;
    }

    function addToPool(record) {
        const links = normalizeStringList(record.links);
        if (links.length === 0) return 0;

        const allExistingLinks = new Set(state.pool.flatMap((item) => item.links));
        const newLinks = links.filter((link) => !allExistingLinks.has(link));

        let target = state.pool.find((item) => item.url === record.url);
        if (!target && newLinks.length === 0) return 0;

        if (!target) {
            target = {
                title: record.title,
                forum: record.forum,
                url: record.url,
                links: [],
                actress: record.actress || '',
                size: record.size || '',
                addedAt: Date.now()
            };
            state.pool.push(target);
        }

        let metaUpdated = false;
        if (record.actress && !target.actress) {
            target.actress = record.actress;
            metaUpdated = true;
        }
        if (record.size && !target.size) {
            target.size = record.size;
            metaUpdated = true;
        }

        let added = 0;
        newLinks.forEach((link) => {
            target.links.push(link);
            added += 1;
        });

        if (added > 0 || metaUpdated) {
            savePool();
            updatePoolUI();
        }
        return added;
    }

    async function extractSelectedResources() {
        if (state.extractRunning) {
            state.extractStopRequested = true;
            updateExtractProgress('正在停止，当前请求结束后生效。');
            return;
        }

        const selected = Array.from(document.querySelectorAll('.drc-thread-checkbox:checked')).filter((cb) => {
            const item = cb.closest('li.pbw, tbody');
            return item && !item.classList.contains('drc-hidden');
        });

        if (selected.length === 0) {
            alert('请先勾选帖子，或者点击“全选/取消”。');
            return;
        }

        state.extractRunning = true;
        state.extractStopRequested = false;
        const extractIntervalMs = Math.max(1, Number(state.settings.extractIntervalSec || 1)) * 1000;
        updateExtractProgress('资源提取：0 / ' + selected.length + ' | 成功 0 | 失败 0 | 新增 0 | 缓存 0 | 间隔 ' + state.settings.extractIntervalSec + ' 秒');

        let success = 0;
        let failed = 0;
        let addedLinks = 0;
        let cacheHits = 0;

        for (let i = 0; i < selected.length; i += 1) {
            if (state.extractStopRequested) break;

            const cb = selected[i];
            const item = cb.closest('li.pbw, tbody');
            const info = extractItemInfo(item);
            let usedCache = false;
            updateExtractProgress('资源提取：' + (i + 1) + ' / ' + selected.length + ' | 成功 ' + success + ' | 失败 ' + failed + ' | 新增 ' + addedLinks + ' | 缓存 ' + cacheHits + ' | 间隔 ' + state.settings.extractIntervalSec + ' 秒');

            try {
                const result = await fetchThreadResources(info.url);
                if (result.fromCache) {
                    cacheHits += 1;
                    usedCache = true;
                }
                if (result.error) {
                    failed += 1;
                    markItemExtractStatus(item, '提取失败：' + result.error, false);
                    renderInlineResources(item, result, 0);
                    addLog('提取失败', result.error + ' | ' + info.title);
                } else if (result.links.length === 0 && result.torrents.length === 0) {
                    failed += 1;
                    markItemExtractStatus(item, '未找到磁链或种子资源', false);
                    renderInlineResources(item, result, 0);
                    addLog('未找到资源', info.title);
                } else {
                    const added = addToPool({
                        title: info.title,
                        forum: info.forumName,
                        url: info.url,
                        links: result.links,
                        torrents: result.torrents,
                        actress: result.actress,
                        size: result.size
                    });
                    addedLinks += added;
                    success += 1;
                    renderInlineResources(item, result, added);
                    markItemExtractStatus(item, '已收纳 ' + result.links.length + ' 个资源，新增 ' + added + ' 个', true);
                }
            } catch (error) {
                failed += 1;
                markItemExtractStatus(item, '网络异常：' + error.message, false);
                addLog('提取失败', error.message + ' | ' + info.title);
            }

            updateExtractProgress('资源提取：' + (i + 1) + ' / ' + selected.length + ' | 成功 ' + success + ' | 失败 ' + failed + ' | 新增 ' + addedLinks + ' | 缓存 ' + cacheHits + ' | 间隔 ' + state.settings.extractIntervalSec + ' 秒');
            if (!state.extractStopRequested && !usedCache) await delay(extractIntervalMs);
        }

        const stopped = state.extractStopRequested;
        state.extractRunning = false;
        state.extractStopRequested = false;
        updateExtractProgress((stopped ? '提取已停止：' : '提取完成：') + '成功 ' + success + ' | 失败 ' + failed + ' | 新增资源 ' + addedLinks + ' | 缓存 ' + cacheHits);
        addLog(stopped ? '提取已停止' : '提取完成', '帖子成功 ' + success + ' 个，失败 ' + failed + ' 个，新增资源 ' + addedLinks + ' 个，缓存命中 ' + cacheHits + ' 个');
        updateOperationStatus();
    }

    function markItemExtractStatus(item, text, ok) {
        if (!item) return;
        let status = item.querySelector('.drc-extract-status');
        if (!status) {
            status = document.createElement('div');
            status.className = 'drc-extract-status';
            const target = item.querySelector('h3, th') || item;
            target.appendChild(status);
        }
        status.textContent = text;
        status.classList.toggle('drc-status-ok', Boolean(ok));
        status.classList.toggle('drc-status-bad', !ok);
    }

    function delay(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function renderInlineResources(item, result, added) {
        if (!item) return;

        let box = item.querySelector('.drc-extracted');
        if (!box) {
            box = document.createElement('div');
            box.className = 'drc-extracted';
            const target = item.querySelector('h3, th') || item;
            target.appendChild(box);
        }
        box.innerHTML = '';

        if (result.error) {
            const error = document.createElement('div');
            error.className = 'drc-inline-error';
            error.textContent = '提取失败：' + result.error;
            box.appendChild(error);
            return;
        }

        if (result.actress || result.size) {
            const meta = document.createElement('div');
            meta.className = 'drc-inline-meta';
            meta.textContent = [
                result.actress ? '女优：' + result.actress : '',
                result.size ? '容量：' + result.size : ''
            ].filter(Boolean).join(' | ');
            box.appendChild(meta);
        }

        const links = normalizeStringList(result.links);
        const torrents = Array.isArray(result.torrents) ? result.torrents : [];

        if (links.length === 0 && torrents.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'drc-inline-empty';
            empty.textContent = '未找到磁链或种子资源';
            box.appendChild(empty);
            return;
        }

        links.forEach((link) => {
            const row = document.createElement('div');
            row.className = 'drc-resource-row';

            const label = document.createElement('span');
            label.className = 'drc-resource-label';
            label.textContent = link.startsWith('ed2k:') ? '电驴' : '磁力';

            const input = document.createElement('input');
            input.className = 'drc-resource-input';
            input.value = link;
            input.readOnly = true;

            const copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'drc-mini-copy';
            copy.textContent = '复制';
            copy.onclick = async () => {
                await copyText(link);
                copy.textContent = '已复制';
                window.setTimeout(() => {
                    copy.textContent = '复制';
                }, 1600);
            };

            row.append(label, input, copy);
            box.appendChild(row);
        });

        torrents.forEach((torrent) => {
            const link = document.createElement('a');
            link.className = 'drc-torrent-link';
            link.href = torrent.href;
            link.target = '_blank';
            link.textContent = '下载种子：' + (torrent.name || '下载附件');
            box.appendChild(link);
        });
    }

    function formatPoolText() {
        if (state.settings.poolCopyMode === 'plain') {
            const links = state.pool.flatMap((item) => item.links || []);
            return [...new Set(links)].join('\n');
        }

        return state.pool.map((item) => {
            const lines = [
                '标题：' + item.title
            ];
            if (item.actress) lines.push('女优：' + item.actress);
            if (item.size) lines.push('容量：' + item.size);
            lines.push('板块：' + (item.forum || '未知版块'));
            lines.push('链接：' + item.url);
            lines.push('资源：');
            lines.push(...item.links);
            return lines.join('\n');
        }).join('\n\n');
    }

    async function copyText(text) {
        if (!text) return;
        if (typeof GM_setClipboard === 'function') {
            GM_setClipboard(text);
            return;
        }
        await navigator.clipboard.writeText(text);
    }

    async function copyPool() {
        if (state.pool.length === 0) {
            alert('收纳池为空。');
            return;
        }
        await copyText(formatPoolText());
        addLog('复制成功', '已按' + (state.settings.poolCopyMode === 'plain' ? '纯链接模式' : '详细模式') + '复制收纳池');
        const btn = document.getElementById('drc-copy-pool');
        if (btn) {
            const old = btn.textContent;
            btn.textContent = '复制成功';
            window.setTimeout(() => {
                btn.textContent = old;
            }, 1800);
        }
    }

    function clearPool() {
        if (state.pool.length === 0) return;
        if (!confirm('确定清空收纳池吗？')) return;
        state.pool = [];
        savePool();
        updatePoolUI();
        addLog('收纳池已清空', '');
    }

    function createRuleManager(title, key, placeholder) {
        const box = document.createElement('div');
        box.className = 'drc-rule-box';

        const label = document.createElement('div');
        label.className = 'drc-section-title';
        label.textContent = title;

        const row = document.createElement('div');
        row.className = 'drc-row';

        const input = document.createElement('input');
        input.className = 'drc-input';
        input.placeholder = placeholder;

        const scope = document.createElement('select');
        scope.className = 'drc-select';
        scope.disabled = true;
        scope.innerHTML = '<option>全局</option>';

        const addButton = document.createElement('button');
        addButton.className = 'drc-button drc-button-gray';
        addButton.textContent = '添加';

        const list = document.createElement('div');
        list.className = 'drc-tags';

        function render() {
            list.innerHTML = '';
            state.settings[key].forEach((value) => {
                const tag = document.createElement('span');
                tag.className = 'drc-tag';
                tag.innerHTML = '<b>全局</b><span></span><button type="button">×</button>';
                tag.querySelector('span').textContent = value;
                tag.querySelector('button').onclick = () => {
                    state.settings[key] = state.settings[key].filter((item) => item !== value);
                    saveSettings();
                    render();
                    processPageItems();
                };
                list.appendChild(tag);
            });
        }

        addButton.onclick = () => {
            const value = input.value.trim();
            if (!value) return;
            if (!state.settings[key].includes(value)) {
                state.settings[key].push(value);
                saveSettings();
                render();
                processPageItems();
            }
            input.value = '';
        };

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') addButton.click();
        });

        row.append(input, scope, addButton);
        box.append(label, row, list);
        render();
        return box;
    }

    function buildUI() {
        const float = document.createElement('button');
        float.id = 'drc-float';
        float.type = 'button';
        float.innerHTML = '<span>助手</span><b id="drc-float-badge">0</b>';
        document.body.appendChild(float);

        const panel = document.createElement('div');
        panel.id = 'drc-panel';
        panel.innerHTML = [
            '<div id="drc-header">',
            '<strong>98堂搜索助手</strong>',
            '<button type="button" id="drc-close">×</button>',
            '</div>',
            '<div id="drc-tabs">',
            '<button type="button" data-tab="ops" class="active">操作</button>',
            '<button type="button" data-tab="pool">收纳</button>',
            '<button type="button" data-tab="rules">规则</button>',
            '<button type="button" data-tab="logs">日志</button>',
            '<button type="button" data-tab="data">数据</button>',
            '</div>',
            '<div id="drc-body">',
            '<section data-panel="ops" class="active"></section>',
            '<section data-panel="pool"></section>',
            '<section data-panel="rules"></section>',
            '<section data-panel="logs"></section>',
            '<section data-panel="data"></section>',
            '</div>'
        ].join('');
        document.body.appendChild(panel);

        float.onclick = () => panel.classList.toggle('open');
        panel.querySelector('#drc-close').onclick = () => panel.classList.remove('open');
        panel.querySelectorAll('#drc-tabs button').forEach((button) => {
            button.onclick = () => {
                const tab = button.dataset.tab;
                panel.querySelectorAll('#drc-tabs button').forEach((btn) => btn.classList.toggle('active', btn === button));
                panel.querySelectorAll('#drc-body section').forEach((section) => {
                    section.classList.toggle('active', section.dataset.panel === tab);
                });
                if (tab === 'pool') updatePoolUI();
                if (tab === 'logs') updateLogUI();
            };
        });

        buildOperationTab(panel.querySelector('[data-panel="ops"]'));
        buildPoolTab(panel.querySelector('[data-panel="pool"]'));
        buildRulesTab(panel.querySelector('[data-panel="rules"]'));
        buildLogsTab(panel.querySelector('[data-panel="logs"]'));
        buildDataTab(panel.querySelector('[data-panel="data"]'));
    }

    function buildOperationTab(root) {
        root.innerHTML = '';

        const seamlessRow = createSettingRow('无缝翻页（滑到底部加载下一页）');
        const seamless = document.createElement('input');
        seamless.type = 'checkbox';
        seamless.checked = state.settings.seamless;
        seamless.onchange = () => {
            state.settings.seamless = seamless.checked;
            saveSettings();
            updateOperationStatus();
        };
        seamlessRow.appendChild(seamless);

        const intervalRow = createSettingRow('自动滚动间隔（秒）');
        const intervalInput = document.createElement('input');
        intervalInput.id = 'drc-scroll-interval';
        intervalInput.type = 'number';
        intervalInput.min = '3';
        intervalInput.step = '1';
        intervalInput.className = 'drc-small-input';
        intervalInput.value = state.settings.scrollIntervalSec;
        intervalInput.onchange = () => {
            state.settings.scrollIntervalSec = Math.max(3, Number(intervalInput.value || 5));
            intervalInput.value = state.settings.scrollIntervalSec;
            saveSettings();
        };
        intervalRow.appendChild(intervalInput);

        const countRow = createSettingRow('自动翻页次数');
        const countInput = document.createElement('input');
        countInput.id = 'drc-page-limit';
        countInput.type = 'number';
        countInput.min = '0';
        countInput.step = '1';
        countInput.className = 'drc-small-input';
        countInput.value = state.settings.maxPageLoads;
        countInput.title = '0 表示不限制次数';
        countInput.onchange = () => {
            state.settings.maxPageLoads = Math.max(0, Number(countInput.value || 0));
            countInput.value = state.settings.maxPageLoads;
            saveSettings();
            updateOperationStatus();
        };
        countRow.appendChild(countInput);

        const extractIntervalRow = createSettingRow('资源提取间隔（秒）');
        const extractIntervalInput = document.createElement('input');
        extractIntervalInput.id = 'drc-extract-interval';
        extractIntervalInput.type = 'number';
        extractIntervalInput.min = '1';
        extractIntervalInput.step = '1';
        extractIntervalInput.className = 'drc-small-input';
        extractIntervalInput.value = state.settings.extractIntervalSec;
        extractIntervalInput.onchange = () => {
            state.settings.extractIntervalSec = Math.max(1, Number(extractIntervalInput.value || 1));
            extractIntervalInput.value = state.settings.extractIntervalSec;
            saveSettings();
        };
        extractIntervalRow.appendChild(extractIntervalInput);

        const status = document.createElement('div');
        status.id = 'drc-op-status';
        status.className = 'drc-status';

        const row1 = document.createElement('div');
        row1.className = 'drc-actions';

        const start = createButton('开始自动滚动', 'blue');
        start.onclick = startAutoScroll;
        const stop = createButton('停止', 'red');
        stop.onclick = () => stopAutoScroll();
        const next = createButton('加载下一页', 'gray');
        next.onclick = () => loadNextPage('手动按钮', { enforceLimit: false });
        row1.append(start, stop, next);

        const row2 = document.createElement('div');
        row2.className = 'drc-actions';
        const selectAll = createButton('全选 / 取消', 'green');
        selectAll.onclick = toggleSelectVisible;
        const extract = createButton('提取勾选资源到收纳池', 'yellow');
        extract.id = 'drc-extract-btn';
        extract.onclick = extractSelectedResources;
        row2.append(selectAll, extract);

        const extractProgress = document.createElement('div');
        extractProgress.id = 'drc-extract-progress';
        extractProgress.className = 'drc-status drc-extract-progress';
        extractProgress.textContent = '资源提取：未运行';

        root.append(seamlessRow, intervalRow, countRow, extractIntervalRow, status, extractProgress, row1, row2);
    }

    function buildPoolTab(root) {
        root.innerHTML = [
            '<div id="drc-pool-stats" class="drc-status"></div>',
            '<label class="drc-setting-row"><span>复制格式</span><select id="drc-copy-mode" class="drc-small-select"><option value="detail">详细模式：标题 + 附加信息 + 资源</option><option value="plain">纯链接模式：仅磁链 / ed2k</option></select></label>',
            '<textarea id="drc-pool-preview" readonly></textarea>',
            '<div class="drc-actions">',
            '<button type="button" id="drc-copy-pool" class="drc-button drc-button-green">一键复制收纳池</button>',
            '<button type="button" id="drc-clear-pool" class="drc-button drc-button-red">清空收纳池</button>',
            '</div>'
        ].join('');
        const copyMode = root.querySelector('#drc-copy-mode');
        copyMode.value = state.settings.poolCopyMode;
        copyMode.onchange = () => {
            state.settings.poolCopyMode = copyMode.value === 'plain' ? 'plain' : 'detail';
            saveSettings();
            updatePoolUI();
        };
        root.querySelector('#drc-copy-pool').onclick = copyPool;
        root.querySelector('#drc-clear-pool').onclick = clearPool;
        updatePoolUI();
    }

    function buildRulesTab(root) {
        root.innerHTML = '';
        root.append(
            createRuleManager('只保留指定版块（白名单）', 'whitelistForums', '如：高清中文字幕'),
            createRuleManager('只保留标题关键词', 'keepTitleKeywords', '如：IPZZ 或 桃乃木'),
            createTitleKeepModeControl(),
            createRuleManager('只保留指定用户', 'keepUsers', '账号或 UID'),
            createRuleManager('屏蔽搜索页中的指定版块', 'blockedForums', '如：求片问答悬赏区'),
            createRuleManager('屏蔽指定分类/标签', 'blockedTags', '完整标签名，如：求助'),
            createRuleManager('屏蔽标题关键词', 'blockedKeywords', '输入屏蔽词'),
            createRuleManager('屏蔽指定用户', 'blockedUsers', '账号或 UID'),
            createRuleManager('高亮标题关键词', 'highlightKeywords', '输入高亮词')
        );
    }

    function buildLogsTab(root) {
        root.innerHTML = [
            '<div class="drc-actions">',
            '<button type="button" id="drc-clear-log" class="drc-button drc-button-gray">清空日志</button>',
            '</div>',
            '<div id="drc-log-list"></div>'
        ].join('');
        root.querySelector('#drc-clear-log').onclick = () => {
            state.logs = [];
            updateLogUI();
        };
        updateLogUI();
    }

    function buildDataTab(root) {
        root.innerHTML = [
            '<div class="drc-note">导出内容包含规则、自动滚动设置和收纳池。</div>',
            '<div class="drc-actions">',
            '<button type="button" id="drc-export" class="drc-button drc-button-blue">导出配置</button>',
            '<button type="button" id="drc-import" class="drc-button drc-button-gray">导入配置</button>',
            '</div>',
            '<input type="file" id="drc-import-file" accept=".json" style="display:none">',
            '<button type="button" id="drc-clear-resource-cache" class="drc-button drc-button-yellow">清理资源缓存</button>',
            '<button type="button" id="drc-reset" class="drc-button drc-button-red">重置本脚本数据</button>'
        ].join('');

        const fileInput = root.querySelector('#drc-import-file');
        root.querySelector('#drc-export').onclick = () => {
            const data = JSON.stringify({
                settings: state.settings,
                pool: state.pool,
                exportedAt: new Date().toISOString()
            }, null, 2);
            const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'discuz-resource-collector-backup.json';
            link.click();
            URL.revokeObjectURL(link.href);
        };
        root.querySelector('#drc-import').onclick = () => fileInput.click();
        root.querySelector('#drc-clear-resource-cache').onclick = async () => {
            if (!confirm('确定清理资源缓存吗？\n\n只会清理详情页资源缓存，不会清空规则、收纳池和其他设置。')) return;
            await CacheDB.clear();
            addLog('资源缓存已清理', '');
            alert('资源缓存已清理。');
        };
        fileInput.onchange = () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(String(reader.result || '{}'));
                    state.settings = normalizeSettings(data.settings || {});
                    state.pool = Array.isArray(data.pool) ? data.pool : [];
                    saveSettings();
                    savePool();
                    alert('导入成功，页面即将刷新。');
                    location.reload();
                } catch (error) {
                    alert('导入失败：文件格式不正确。');
                }
            };
            reader.readAsText(file, 'utf-8');
        };
        root.querySelector('#drc-reset').onclick = async () => {
            if (!confirm('确定重置本脚本的所有设置和收纳池吗？')) return;
            GM_deleteValue(STORAGE_PREFIX + 'settings');
            GM_deleteValue(STORAGE_PREFIX + 'pool');
            await CacheDB.clear();
            location.reload();
        };
    }

    function createSettingRow(labelText) {
        const row = document.createElement('label');
        row.className = 'drc-setting-row';
        const span = document.createElement('span');
        span.textContent = labelText;
        row.appendChild(span);
        return row;
    }

    function createButton(text, color) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'drc-button drc-button-' + color;
        button.textContent = text;
        return button;
    }

    function createTitleKeepModeControl() {
        const row = createSettingRow('标题保留模式');
        const select = document.createElement('select');
        select.className = 'drc-small-select';
        select.innerHTML = '<option value="or">或：命中任意一个</option><option value="and">与：必须全部命中</option>';
        select.value = state.settings.keepTitleMode;
        select.onchange = () => {
            state.settings.keepTitleMode = select.value === 'and' ? 'and' : 'or';
            saveSettings();
            processPageItems();
        };
        row.appendChild(select);
        return row;
    }

    function updateOperationStatus(extra) {
        const status = document.getElementById('drc-op-status');
        if (!status) return;

        const maxText = state.settings.maxPageLoads > 0 ? String(state.settings.maxPageLoads) : '不限';
        const nextText = state.nextPageUrl ? '有' : '无';
        const autoText = state.autoScrollTimer ? '运行中' : '未运行';
        const selected = document.querySelectorAll('.drc-thread-checkbox:checked').length;
        status.textContent = [
            '自动滚动：' + autoText,
            '已翻页：' + state.loadedPageCount + ' / ' + maxText,
            '下一页：' + nextText,
            '总条数：' + state.totalCount,
            '已过滤：' + state.hiddenCount,
            '剩余：' + state.remainingCount,
            '已勾选：' + selected,
            extra || ''
        ].filter(Boolean).join(' | ');
    }

    function updateExtractProgress(text) {
        const progress = document.getElementById('drc-extract-progress');
        if (progress) progress.textContent = text || '资源提取：未运行';

        const button = document.getElementById('drc-extract-btn');
        if (!button) return;

        if (state.extractRunning) {
            button.textContent = state.extractStopRequested ? '正在停止...' : '停止提取';
            button.classList.remove('drc-button-yellow');
            button.classList.add('drc-button-red');
        } else {
            button.textContent = '提取勾选资源到收纳池';
            button.classList.remove('drc-button-red');
            button.classList.add('drc-button-yellow');
        }
    }

    function updatePoolUI() {
        const stats = document.getElementById('drc-pool-stats');
        const preview = document.getElementById('drc-pool-preview');
        if (!stats || !preview) return;

        const linkCount = state.pool.reduce((sum, item) => sum + item.links.length, 0);
        stats.textContent = '收纳记录：' + state.pool.length + ' 条，资源：' + linkCount + ' 个';
        preview.value = formatPoolText();
    }

    function updateLogUI() {
        const list = document.getElementById('drc-log-list');
        if (!list) return;
        list.innerHTML = '';
        if (state.logs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'drc-note';
            empty.textContent = '暂无日志';
            list.appendChild(empty);
            return;
        }
        state.logs.forEach((log) => {
            const item = document.createElement('div');
            item.className = 'drc-log-item';
            item.innerHTML = '<b></b><span></span><p></p>';
            item.querySelector('b').textContent = '[' + log.time + '] ' + log.message;
            item.querySelector('span').textContent = log.detail;
            list.appendChild(item);
        });
    }

    function updateFloatBadge() {
        const badge = document.getElementById('drc-float-badge');
        if (badge) badge.textContent = String(state.remainingCount);
    }

    function observeListChanges() {
        const target = document.querySelector('#threadlist') || document.querySelector('#threadlisttableid');
        if (!target) return;
        const observer = new MutationObserver(() => {
            window.clearTimeout(observeListChanges.timer);
            observeListChanges.timer = window.setTimeout(processPageItems, 150);
        });
        observer.observe(target, { childList: true, subtree: true });
    }

    GM_addStyle(`
        .drc-hidden { display: none !important; }
        .drc-highlight { background: #fff2a8; color: #c40000 !important; font-weight: 700; padding: 0 3px; border-radius: 3px; }
        #drc-filter-tip { margin: 10px 0; padding: 9px 12px; border: 1px solid #e55353; color: #c82333; background: #fff7f7; border-radius: 4px; font-size: 13px; font-weight: 700; }
        #drc-float { position: fixed; right: 22px; bottom: 28px; z-index: 999998; width: 68px; height: 68px; border-radius: 50%; border: 2px solid #ffffff; background: linear-gradient(135deg, #1677ff, #39b980); color: #ffffff; box-shadow: 0 8px 22px rgba(0,0,0,.25); cursor: pointer; font-weight: 700; }
        #drc-float span { display: block; font-size: 15px; line-height: 1; }
        #drc-float-badge { position: absolute; top: -6px; right: -6px; min-width: 22px; height: 22px; padding: 0 5px; border-radius: 999px; background: #ff4d4f; color: #fff; font-size: 12px; line-height: 22px; box-sizing: border-box; }
        #drc-panel { position: fixed; right: 22px; bottom: 108px; z-index: 999999; width: 420px; max-width: calc(100vw - 44px); max-height: 78vh; display: none; flex-direction: column; background: #ffffff; color: #222; border: 1px solid #cfd6dd; border-radius: 8px; box-shadow: 0 14px 34px rgba(0,0,0,.28); overflow: hidden; font-size: 14px; }
        #drc-panel.open { display: flex; }
        #drc-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; background: #5f6b76; color: #fff; }
        #drc-header strong { font-size: 17px; }
        #drc-close { width: 30px; height: 30px; border: none; background: transparent; color: #fff; font-size: 28px; line-height: 28px; cursor: pointer; }
        #drc-tabs { display: flex; border-bottom: 1px solid #d8dee4; background: #f5f7f9; }
        #drc-tabs button { flex: 1; border: none; background: transparent; padding: 10px 0; color: #333; cursor: pointer; font-weight: 700; }
        #drc-tabs button.active { color: #1677ff; border-bottom: 3px solid #1677ff; background: #fff; }
        #drc-body { overflow: auto; padding: 12px; }
        #drc-body section { display: none; }
        #drc-body section.active { display: block; }
        .drc-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 0; }
        .drc-setting-row span { font-weight: 700; }
        .drc-small-input { width: 88px; padding: 5px 6px; border: 1px solid #cfd6dd; border-radius: 4px; }
        .drc-small-select { width: 190px; padding: 6px 6px; border: 1px solid #cfd6dd; border-radius: 4px; background: #fff; }
        .drc-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        .drc-button { border: none; border-radius: 5px; padding: 8px 11px; color: #fff; cursor: pointer; font-weight: 700; line-height: 1.2; }
        .drc-button:hover { opacity: .86; }
        .drc-button-blue { background: #1677ff; }
        .drc-button-red { background: #dc3545; }
        .drc-button-green { background: #28a745; }
        .drc-button-yellow { background: #ffc107; color: #222; }
        .drc-button-gray { background: #6c757d; }
        .drc-status { margin: 10px 0; padding: 8px; border-radius: 5px; background: #f2f5f8; color: #334; font-size: 13px; line-height: 1.5; }
        .drc-section-title { margin: 12px 0 6px; font-size: 15px; font-weight: 800; }
        .drc-row { display: flex; gap: 7px; }
        .drc-input { flex: 1; min-width: 0; padding: 7px 8px; border: 1px solid #cfd6dd; border-radius: 4px; }
        .drc-select { width: 78px; padding: 7px 4px; border: 1px solid #cfd6dd; border-radius: 4px; background: #f7f7f7; color: #555; }
        .drc-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; max-height: 82px; overflow: auto; }
        .drc-tag { display: inline-flex; align-items: center; gap: 5px; padding: 4px 6px; border: 1px solid #cfd6dd; border-radius: 4px; background: #f1f4f7; }
        .drc-tag b { padding: 1px 4px; border-radius: 3px; background: #28a745; color: #fff; font-size: 11px; }
        .drc-tag button { border: none; background: transparent; color: #dc3545; font-size: 18px; line-height: 16px; cursor: pointer; }
        #drc-pool-preview { width: 100%; min-height: 240px; resize: vertical; box-sizing: border-box; border: 1px solid #cfd6dd; border-radius: 5px; padding: 8px; font-size: 12px; line-height: 1.5; }
        .drc-note { color: #667; font-size: 13px; line-height: 1.5; padding: 8px; background: #f7f8fa; border-radius: 5px; }
        .drc-log-item { border-bottom: 1px dashed #d8dee4; padding: 7px 0; }
        .drc-log-item b { display: block; color: #222; margin-bottom: 3px; }
        .drc-log-item span { color: #666; word-break: break-all; }
        .drc-extract-status { margin-top: 7px; padding: 4px 7px; border-radius: 4px; font-size: 12px; display: inline-block; }
        .drc-status-ok { background: #e8f7ee; color: #20833d; border: 1px solid #9dd6ad; }
        .drc-status-bad { background: #fff1f0; color: #c82333; border: 1px solid #f1a1a8; }
        .drc-extracted { margin: 10px 0 0 24px; display: flex; flex-direction: column; gap: 7px; max-width: 100%; }
        .drc-inline-meta { color: #334; font-size: 13px; font-weight: 700; }
        .drc-inline-error, .drc-inline-empty { color: #c82333; font-size: 13px; font-weight: 700; }
        .drc-resource-row { display: flex; align-items: center; gap: 8px; max-width: 100%; }
        .drc-resource-label { width: 42px; color: #666; font-size: 13px; font-weight: 700; flex: 0 0 auto; }
        .drc-resource-input { flex: 1; min-width: 160px; padding: 7px 9px; border: 1px solid #28a745; border-radius: 4px; font-size: 13px; color: #333; background: #fff; box-sizing: border-box; }
        .drc-mini-copy { flex: 0 0 auto; padding: 7px 12px; border: none; border-radius: 4px; background: #6c757d; color: #fff; font-weight: 700; cursor: pointer; }
        .drc-torrent-link { display: inline-block; align-self: flex-start; padding: 6px 12px; border-radius: 4px; background: #1677ff; color: #fff !important; text-decoration: none !important; font-weight: 700; font-size: 13px; }
        @media (max-width: 520px) {
            #drc-panel { right: 10px; bottom: 88px; width: calc(100vw - 20px); max-width: none; }
            #drc-float { right: 14px; bottom: 16px; }
        }
    `);

    buildUI();
    processPageItems();
    observeListChanges();
    updateOperationStatus();
    CacheDB.init().then(() => {
        addLog('资源缓存已就绪', '有效期 2 天');
    });
    window.setInterval(() => {
        CacheDB.clean();
    }, 10 * 60 * 1000);
    addLog('脚本已启动', '当前下一页：' + (state.nextPageUrl ? '有' : '无'));
})();
