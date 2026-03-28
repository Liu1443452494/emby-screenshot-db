// ==UserScript==
// @name         Emby Media Info Enhancer (Strict Colorized)
// @name:zh-CN   Emby 媒体信息UI增强
// @namespace    https://github.com/kjtsune/embyToLocalPlayer
// @version      4.0.0
// @description  严格复刻原版逻辑，仅移除播放功能并添加颜色区分。第一行文件名(蓝)，第二行原始，第三行路径(橙)。
// @author       Modified by User
// @match        *://*/web/index.html*
// @match        *://*/*/web/index.html*
// @match        *://*/web/
// @match        *://*/*/web/
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 1. 核心变量与辅助函数 (保留原版) ---
    injectGlassStyles();
    let allItemDataCache = {};
    const originFetch = unsafeWindow.fetch;

    async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getVisibleElement(elList) {
        if (!elList) return;
        if (Object.prototype.isPrototypeOf.call(NodeList.prototype, elList)) {
            for (let i = 0; i < elList.length; i++) {
                if (elList[i].offsetParent !== null) {
                    return elList[i];
                }
            }
        } else {
            return elList;
        }
    }

    function throttle(fn, delay) {
        let lastTime = 0;
        return function (...args) {
            const now = Date.now();
            if (now - lastTime >= delay) {
                lastTime = now;
                fn.apply(this, args);
            }
        };
    }

    function injectGlassStyles() {
        const style = document.createElement('style');
        style.textContent = `
            /* 媒体流卡片毛玻璃化 (白色版) */
            .mediaStreamPadder.defaultCardBackground {
                backdrop-filter: blur(25px) saturate(180%) !important;
                -webkit-backdrop-filter: blur(25px) saturate(180%) !important;
                background-color: rgba(255, 255, 255, 0.12) !important;
                border: 1px solid rgba(255, 255, 255, 0.25) !important;
                border-radius: 12px !important;
                box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.15) !important;
            }
            /* 确保内部容器背景透明 */
            .mediaStreamInnerCardFooter {
                background: transparent !important;
            }
            /* 调整卡片间距与对齐 */
            .metadataSidebar .card {
                margin-right: 10px !important;
            }
            .itemLinks {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-top: 15px !important;
            }
            .itemLinks a.button-link {
                background: rgba(255, 255, 255, 0.15) !important;
                border: 1px solid rgba(255, 255, 255, 0.2) !important;
                padding: 5px 15px !important;
                border-radius: 20px !important;
                font-size: 0.9em !important;
                text-decoration: none !important;
                transition: all 0.2s ease-in-out !important;
                display: inline-flex !important;
                align-items: center;
                color: #eee !important;
            }
            /* 悬停效果 */
            .itemLinks a.button-link:hover {
                background: rgba(255, 255, 255, 0.3) !important;
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
                color: #fff !important;
            }
            .peopleItemsContainer .card {
                transition: transform 0.3s ease !important;
                overflow: visible !important;
            }
            .peopleItemsContainer .cardBox {
                border-radius: 16px !important; /* 更圆润的头像框 */
                border: 1px solid rgba(255, 255, 255, 0.1) !important;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3) !important;
                transition: all 0.3s cubic-bezier(0.165, 0.84, 0.44, 1) !important;
                background: rgba(255, 255, 255, 0.03) !important;
            }
            /* 悬停时的 3D 提升效果 */
            .peopleItemsContainer .card:hover .cardBox {
                transform: scale(1.05) !important; /* 恢复整卡放大 */
                transform-origin: center center !important; /* 强制中心缩放，解决向上跳的问题 */
                box-shadow: 0 15px 30px rgba(0, 0, 0, 0.5) !important;
                border-color: rgba(255, 255, 255, 0.3) !important;
                background: rgba(255, 255, 255, 0.08) !important;
            }
            /* 头像图片圆角同步 */
            .peopleItemsContainer .cardImage,
            .peopleItemsContainer .cardContent {
                border-radius: 16px !important;
            }
            /* 修复滚动容器遮挡位移动效 */
            .peopleSection .emby-scroller {
                padding-top: 12px !important;
            }
            .portraitCard:not(.card-horiz) .cardImageContainer {
                overflow: hidden !important;
                border-radius: 12px !important;
            }
            .portraitCard:not(.card-horiz) .cardImage {
                transition: transform 0.25s ease-out !important;
                transform-origin: center center !important;
            }
            .portraitCard:not(.card-horiz):hover .cardImage {
                transform: scale(1.01) !important;
            }
            /* 确保普通海报的容器在悬停时不发生位移或缩放 */
            .portraitCard:not(.card-horiz):hover .cardBox {
                transform: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    async function cloneAndCacheFetch(resp, key, cache) {
        try {
            const data = await resp.clone().json();
            cache[key] = data;
            return data;
        } catch (_error) {
            // pass
        }
    }

    // --- 2. UI 逻辑函数 (完全保留原版逻辑，仅修改 HTML 样式) ---

    // 逻辑 A: 添加文件名 (第一行)
    async function addFileNameElement(resp) {
        let mediaSources = null;
        for (const _ of Array(5).keys()) {
            await sleep(500);
            mediaSources = getVisibleElement(document.querySelectorAll('div.mediaSources'));
            if (mediaSources) break;
        }
        if (!mediaSources) return;

        // 原版逻辑：获取所有 div
        let pathDivs = mediaSources.querySelectorAll('div[class^="sectionTitle sectionTitle-cards"] > div');
        if (!pathDivs) return;
        pathDivs = Array.from(pathDivs);

        let _pathDiv = pathDivs[0];
        if (_pathDiv.id == 'addFileNameElement') return; // 防止重复添加

        // 原版逻辑：判断是否为管理员
        let isAdmin = !/\d{4}\/\d+\/\d+/.test(_pathDiv.textContent);
        let isStrm = _pathDiv.textContent.startsWith('http');

        if (isAdmin) {
            if (!isStrm) { return; }
            // 原版逻辑：管理员模式下过滤掉日期行
            pathDivs = pathDivs.filter((_, index) => index % 2 === 0);
        }

        let sources = await resp.clone().json();
        sources = sources.MediaSources;

        for (let index = 0; index < pathDivs.length; index++) {
            const pathDiv = pathDivs[index];
            let dateDiv = pathDiv.parentNode.querySelector('.mediaInfoItems');
            let borderTarget = (isAdmin && dateDiv) ? dateDiv : pathDiv;

            borderTarget.style.borderBottom = '3px solid rgba(255, 255, 255, 0.1)';
            borderTarget.style.paddingBottom = '10px';
            borderTarget.style.marginTop = '8px';
            let fileName = sources[index].Name;
            let filePath = sources[index].Path;
            let strmFile = filePath.startsWith('http');

            if (!strmFile) {
                // 原版逻辑：切割路径获取文件名
                fileName = filePath.split('\\').pop().split('/').pop();
            }

            // 【修改点】：添加颜色样式 (亮蓝色)
            // 原代码: let fileDiv = `<div id="addFileNameElement">${fileName}</div> `
            let fileDiv = `<div id="addFileNameElement" style="color: #64B5F6; font-weight: bold; margin-bottom: 5px; font-size: 1.1em;">${fileName}</div> `;

            if (strmFile && (!isAdmin)) { // 原版这里有个 config.crackFullPath 判断，这里默认启用或保持逻辑
                 // 如果是 STRM 且非管理员，原版逻辑会显示完整路径，这里我们也加上颜色
                 fileDiv = `<div id="addFileNameElement" style="color: #64B5F6; font-weight: bold; margin-bottom: 5px;">${fileName}<br>${filePath}</div> `;
            }

            pathDiv.insertAdjacentHTML('beforebegin', fileDiv);
        }
    }

    // 逻辑 B: 添加物理路径 (第三行)
    // 原版使用 throttle
    let addOpenFolderElement = throttle(_addOpenFolderElement, 100);

    async function _addOpenFolderElement(itemId) {
        let mediaSources = null;
        for (const _ of Array(5).keys()) {
            await sleep(500);
            mediaSources = getVisibleElement(document.querySelectorAll('div.mediaSources'));
            if (mediaSources) break;
        }
        if (!mediaSources) return;

        // 原版逻辑：只获取第一个 div (querySelector)
        let pathDiv = mediaSources.querySelector('div[class^="sectionTitle sectionTitle-cards"] > div');
        if (!pathDiv || pathDiv.className == 'mediaInfoItems' || pathDiv.id == 'addFileNameElement') return;

        let full_path = pathDiv.textContent;
        if (!full_path.match(/[\\/:]/)) return;
        // 原版逻辑：排除非 STRM (通过 MB/GB 判断)
        if (full_path.match(/\d{1,3}\.?\d{0,2} (MB|GB)/)) return;

        // 原版逻辑：从缓存获取 Item 数据
        let itemData = (itemId in allItemDataCache) ? allItemDataCache[itemId] : null
        let strmFile = (full_path.startsWith('http')) ? itemData?.Path : null

        // 【修改点】：移除 Open Folder 按钮，仅显示路径并着色
        // 原版逻辑是 pathDiv.innerHTML = pathDiv.innerHTML + '<br>' + strmFile;
        // 我们改为插入一个带颜色的 div
        if (strmFile) {
            // 橙色显示物理路径
            let pathHtml = `<div style="color: #FFB74D; font-size: 0.9em; margin-top: 5px; word-break: break-all;">${strmFile}</div>`;
            pathDiv.insertAdjacentHTML('afterend', pathHtml);
        }
    }

    // --- 3. 拦截 Fetch (保留原版缓存与触发逻辑) ---

    let itemInfoRe = /\/Items\/(\w+)\?/;

    unsafeWindow.fetch = async (input, options) => {
        let isStrInput = typeof input === 'string';
        let urlStr = isStrInput ? input : input.url;

        // 1. 缓存 Item 数据 (为了 _addOpenFolderElement 能拿到 Path)
        if (urlStr.match(itemInfoRe)) {
            let itemId = urlStr.match(itemInfoRe)[1];
            let resp = await originFetch(input, options);
            cloneAndCacheFetch(resp, itemId, allItemDataCache);
            return resp;
        }

        // 2. 触发 UI 渲染 (在 PlaybackInfo 请求时)
        if (urlStr.indexOf('/PlaybackInfo?UserId') != -1) {
            let itemId = urlStr.match(/\/Items\/(\w+)\/PlaybackInfo/)[1];
            let resp = await originFetch(input, options);

            // 调用 UI 函数
            addFileNameElement(resp.clone());
            addOpenFolderElement(itemId);

            return resp;
        }

        return originFetch(input, options);
    }

})();