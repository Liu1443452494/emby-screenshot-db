/**
 * ============================================================
 * HDHive 资源添加时间显示 - 使用说明
 * ============================================================
 * 
 * 功能：
 *   - 在HDHive资源卡片右上角显示资源添加时间
 *   - 按时间排序资源卡片（最新在前）
 *   - 支持多Tab切换（不同网盘独立排序）
 * 
 * 配置：
 *   1. 打开脚本编辑页面
 *   2. 找到下方的 API_KEY 变量（约第57行）
 *   3. 将你的API Key填入引号中
 *      例如：const API_KEY = '你的API密钥';
 *   4. 找到 TIME_STYLE 变量（约第58行）
 *   5. 修改数字选择样式（1-7）
 * 
 * 时间标签样式：
 *   1 - 简约透明（灰色背景）
 *   2 - 渐变胶囊（紫蓝渐变）← 默认
 *   3 - 玻璃拟态（毛玻璃效果）
 *   4 - 霓虹效果（绿色发光）
 *   5 - 标签徽章（红色醒目）
 *   6 - 暗金质感（金色边框）
 *   7 - 极简圆点（左侧竖线）
 * 
 * API Key获取方式：
 *   - 登录 HDHive 网站
 *   - 进入个人设置 -> API 设置
 *   - 生成或复制你的 API Key
 * 
 * 适用页面：
 *   - https://hdhive.com/movie/*
 *   - https://hdhive.com/tv/*
 *   - https://hdhive.com/tmdb/movie/*
 *   - https://hdhive.com/tmdb/tv/*
 * 
 * 版本历史：
 *   v2.5 - 添加7种时间标签样式可选
 *   v2.4 - 每次Tab切换都重新排序
 *   v2.3 - 修复重定向后Tab切换失效问题
 *   v2.2 - 添加卡片渲染等待重试机制
 *   v2.1 - 修复Tab切换时时间标签丢失问题
 *   v2.0 - 移除MutationObserver，使用Set记录已排序Tab
 *   v1.9 - 添加Tab切换支持
 * 
 * ============================================================
 */

// ==UserScript==
// @name         HDHive 资源添加时间显示
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  在HDHive资源卡片右上角显示添加时间，并按时间排序
// @author       You
// @match        https://hdhive.com/movie/*
// @match        https://hdhive.com/tv/*
// @match        https://hdhive.com/tmdb/movie/*
// @match        https://hdhive.com/tmdb/tv/*
// @grant        GM_xmlhttpRequest
// @connect      hdhive.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const API_KEY = '14df4a54e93c96e701db5cb2f29c3aba';
    const TIME_STYLE = 2;
    const BASE_URL = 'https://hdhive.com/api/open';

    const TIME_STYLES = {
        1: {
            color: '#999',
            fontSize: '12px',
            background: 'rgba(0, 0, 0, 0.6)',
            padding: '2px 6px',
            borderRadius: '4px',
            border: 'none',
            fontWeight: 'normal',
            textShadow: 'none',
            backdropFilter: 'none'
        },
        2: {
            color: '#fff',
            fontSize: '11px',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            padding: '3px 8px',
            borderRadius: '12px',
            border: 'none',
            fontWeight: '500',
            textShadow: 'none',
            backdropFilter: 'none'
        },
        3: {
            color: '#fff',
            fontSize: '12px',
            background: 'rgba(255, 255, 255, 0.15)',
            padding: '3px 8px',
            borderRadius: '6px',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            fontWeight: 'normal',
            textShadow: 'none',
            backdropFilter: 'blur(4px)'
        },
        4: {
            color: '#00ff88',
            fontSize: '11px',
            background: 'rgba(0, 0, 0, 0.7)',
            padding: '3px 8px',
            borderRadius: '4px',
            border: '1px solid #00ff88',
            fontWeight: 'normal',
            textShadow: '0 0 5px #00ff88',
            backdropFilter: 'none'
        },
        5: {
            color: '#fff',
            fontSize: '10px',
            background: '#ff4757',
            padding: '2px 6px',
            borderRadius: '2px',
            border: 'none',
            fontWeight: 'bold',
            textShadow: 'none',
            backdropFilter: 'none'
        },
        6: {
            color: '#ffd700',
            fontSize: '11px',
            background: 'linear-gradient(180deg, #2d2d2d 0%, #1a1a1a 100%)',
            padding: '3px 8px',
            borderRadius: '4px',
            border: '1px solid #ffd700',
            fontWeight: '500',
            textShadow: 'none',
            backdropFilter: 'none'
        },
        7: {
            color: '#aaa',
            fontSize: '10px',
            background: 'transparent',
            padding: '0 0 0 6px',
            borderRadius: '0',
            border: 'none',
            borderLeft: '2px solid #667eea',
            fontWeight: 'normal',
            textShadow: 'none',
            backdropFilter: 'none'
        }
    };

    let tmdbId = null;
    let mediaType = null;
    let resourcesCache = null;
    let currentUrl = window.location.href;
    let pendingTmdbId = null;
    let pendingMediaType = null;
    let currentSessionId = 0;
    let tabListenersAdded = false;

    function getMediaType() {
        const url = window.location.href;
        if (url.includes('/movie/')) return 'movie';
        if (url.includes('/tv/')) return 'tv';
        return null;
    }

    function extractTmdbIdFromUrl(url) {
        let match = url.match(/\/tmdb\/movie\/(\d+)/);
        if (match) {
            return { tmdbId: match[1], mediaType: 'movie' };
        }
        match = url.match(/\/tmdb\/tv\/(\d+)/);
        if (match) {
            return { tmdbId: match[1], mediaType: 'tv' };
        }
        return null;
    }

    function fetchResources(tmdbId, mediaType) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${BASE_URL}/resources/${mediaType}/${tmdbId}`,
                headers: {
                    'X-API-Key': API_KEY
                },
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.success && data.data) {
                            resolve(data.data);
                        } else {
                            reject('API返回数据格式错误');
                        }
                    } catch (e) {
                        reject('解析响应失败: ' + e.message);
                    }
                },
                onerror: function(error) {
                    reject('请求失败: ' + error);
                }
            });
        });
    }

    function createTimeElement(createdAt) {
        const timeDiv = document.createElement('div');
        timeDiv.className = 'hdhive-created-time';
        timeDiv.textContent = createdAt;
        
        const style = TIME_STYLES[TIME_STYLE] || TIME_STYLES[1];
        
        timeDiv.style.cssText = `
            position: absolute;
            top: 8px;
            right: 8px;
            color: ${style.color};
            font-size: ${style.fontSize};
            background: ${style.background};
            padding: ${style.padding};
            border-radius: ${style.borderRadius};
            border: ${style.border};
            font-weight: ${style.fontWeight};
            text-shadow: ${style.textShadow};
            backdrop-filter: ${style.backdropFilter};
            -webkit-backdrop-filter: ${style.backdropFilter};
            z-index: 10;
            white-space: nowrap;
            pointer-events: none;
        `;
        return timeDiv;
    }

    function findCardBySlug(slug) {
        const allLinks = document.querySelectorAll('a[href*="' + slug + '"]');
        for (const link of allLinks) {
            let card = link.closest('[class*="card"], [class*="Card"], [class*="item"], [class*="Item"], [class*="resource"], [class*="Resource"]');
            if (card) return card;
            card = link.parentElement;
            while (card && card !== document.body) {
                if (card.querySelector('a[href*="' + slug + '"]') === link) {
                    const style = window.getComputedStyle(card);
                    if (style.position === 'relative' || style.position === 'absolute' || style.position === 'static') {
                        return card;
                    }
                }
                card = card.parentElement;
            }
        }
        return null;
    }

    function getCurrentTabKey() {
        const selectedTab = document.querySelector('.MuiTab-root.Mui-selected');
        if (!selectedTab) return null;
        return selectedTab.textContent;
    }

    function sortCardsByTime(resources) {
        if (!resources || resources.length === 0) return false;

        const tabKey = getCurrentTabKey();
        if (!tabKey) return false;

        const gridContainer = document.querySelector('.MuiGrid-root.MuiGrid-container.MuiGrid-spacing-xs-2');
        if (!gridContainer) return false;

        const visibleCards = [];
        resources.forEach(resource => {
            const card = findCardBySlug(resource.slug);
            if (card && gridContainer.contains(card)) {
                visibleCards.push({
                    card: card,
                    resource: resource
                });
            }
        });

        if (visibleCards.length < 2) {
            return true;
        }

        visibleCards.sort((a, b) => {
            const timeA = new Date(a.resource.created_at).getTime();
            const timeB = new Date(b.resource.created_at).getTime();
            return timeB - timeA;
        });

        visibleCards.forEach(item => {
            gridContainer.appendChild(item.card);
        });

        console.log(`[HDHive时间] 已按时间排序 ${visibleCards.length} 个卡片（最新在前）`);
        return true;
    }

    function addTimeToCards(resources) {
        if (!resources || resources.length === 0) return 0;

        let addedCount = 0;
        resources.forEach(resource => {
            const card = findCardBySlug(resource.slug);
            if (card && !card.querySelector('.hdhive-created-time')) {
                const existingPosition = window.getComputedStyle(card).position;
                if (existingPosition === 'static') {
                    card.style.position = 'relative';
                }
                const timeElement = createTimeElement(resource.created_at);
                card.appendChild(timeElement);
                addedCount++;
            }
        });

        if (addedCount > 0) {
            console.log(`[HDHive时间] 成功添加 ${addedCount} 个时间标签`);
        }
        return addedCount;
    }

    function findTmdbIdInPage() {
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const content = script.textContent;
            if (content && content.includes('tmdb_id')) {
                let match = content.match(/\\\"tmdb_id\\\":\\\"(\d+)\\\"/);
                if (match) {
                    tmdbId = match[1];
                    return true;
                }
                match = content.match(/"tmdb_id":"(\d+)"/);
                if (match) {
                    tmdbId = match[1];
                    return true;
                }
                match = content.match(/"tmdb_id":(\d+)/);
                if (match) {
                    tmdbId = match[1];
                    return true;
                }
            }
        }
        return false;
    }

    function processTab(retryCount = 0, sessionId) {
        if (!resourcesCache || sessionId !== currentSessionId) return;
        
        const tabKey = getCurrentTabKey();
        if (!tabKey) {
            if (retryCount < 10 && sessionId === currentSessionId) {
                console.log(`[HDHive时间] 等待Tab渲染... (${retryCount + 1}/10)`);
                setTimeout(() => processTab(retryCount + 1, sessionId), 500);
            }
            return;
        }

        const addedCount = addTimeToCards(resourcesCache);
        
        if (addedCount === 0 && retryCount < 10 && sessionId === currentSessionId) {
            console.log(`[HDHive时间] 卡片未渲染，等待重试... (${retryCount + 1}/10)`);
            setTimeout(() => processTab(retryCount + 1, sessionId), 500);
            return;
        }
        
        sortCardsByTime(resourcesCache);
    }

    function addTabListeners() {
        if (tabListenersAdded) return;
        
        document.querySelectorAll('.MuiTab-root').forEach(tab => {
            tab.addEventListener('click', () => {
                setTimeout(() => {
                    if (!resourcesCache) return;
                    const tabKey = getCurrentTabKey();
                    if (tabKey) {
                        console.log(`[HDHive时间] Tab切换到: ${tabKey}`);
                        processTab(0, currentSessionId);
                    }
                }, 300);
            });
        });
        
        tabListenersAdded = true;
        console.log(`[HDHive时间] 已添加Tab切换监听器，当前样式: ${TIME_STYLE}`);
    }

    async function processResources(sessionId) {
        if (!tmdbId || !mediaType || resourcesCache) return;

        console.log(`[HDHive时间] ================================`);
        console.log(`[HDHive时间] 媒体类型: ${mediaType.toUpperCase()}`);
        console.log(`[HDHive时间] TMDB ID: ${tmdbId}`);
        console.log(`[HDHive时间] API请求: ${BASE_URL}/resources/${mediaType}/${tmdbId}`);
        console.log(`[HDHive时间] ================================`);

        try {
            const resources = await fetchResources(tmdbId, mediaType);
            
            if (sessionId !== currentSessionId) {
                console.log(`[HDHive时间] 会话已过期，放弃本次请求结果`);
                return;
            }
            
            resourcesCache = resources;
            console.log(`[HDHive时间] 获取到 ${resources.length} 个资源`);

            processTab(0, sessionId);
            addTabListeners();

        } catch (error) {
            console.error('[HDHive时间] 错误:', error);
        }
    }

    function resetAndRun() {
        currentSessionId++;
        const sessionId = currentSessionId;
        
        tmdbId = null;
        mediaType = null;
        resourcesCache = null;
        tabListenersAdded = false;

        const urlInfo = extractTmdbIdFromUrl(window.location.href);
        if (urlInfo) {
            pendingTmdbId = urlInfo.tmdbId;
            pendingMediaType = urlInfo.mediaType;
            console.log(`[HDHive时间] 从URL提取 TMDB ID: ${pendingTmdbId}, 媒体类型: ${pendingMediaType}`);
        }

        mediaType = getMediaType();

        if (!mediaType) {
            console.log('[HDHive时间] 当前页面不是电影/电视剧详情页');
            return;
        }

        console.log('[HDHive时间] 脚本初始化...');

        let retryCount = 0;
        const maxRetry = 60;

        function checkAndProcess() {
            if (sessionId !== currentSessionId) return;

            if (resourcesCache) return;

            if (pendingTmdbId && pendingMediaType === mediaType) {
                tmdbId = pendingTmdbId;
                console.log(`[HDHive时间] 使用URL中的 TMDB ID: ${tmdbId}`);
                processResources(sessionId);
                return;
            }

            if (findTmdbIdInPage()) {
                processResources(sessionId);
                return;
            }

            retryCount++;
            if (retryCount < maxRetry && sessionId === currentSessionId) {
                setTimeout(checkAndProcess, 500);
            } else {
                console.log('[HDHive时间] 未能在页面中找到 tmdb_id');
            }
        }

        setTimeout(checkAndProcess, 500);
    }

    function watchUrlChange() {
        setInterval(() => {
            if (window.location.href !== currentUrl) {
                console.log('[HDHive时间] 检测到URL变化');
                console.log(`[HDHive时间] 旧URL: ${currentUrl}`);
                console.log(`[HDHive时间] 新URL: ${window.location.href}`);
                
                const urlInfo = extractTmdbIdFromUrl(window.location.href);
                if (urlInfo) {
                    pendingTmdbId = urlInfo.tmdbId;
                    pendingMediaType = urlInfo.mediaType;
                    console.log(`[HDHive时间] 从URL提取 TMDB ID: ${pendingTmdbId}, 媒体类型: ${pendingMediaType}`);
                }
                
                currentUrl = window.location.href;
                resetAndRun();
            }
        }, 500);
    }

    function init() {
        console.log('[HDHive时间] 脚本加载...');
        resetAndRun();
        watchUrlChange();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
