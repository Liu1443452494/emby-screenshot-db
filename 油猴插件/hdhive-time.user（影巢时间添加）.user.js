/**
 * ============================================================
 * HDHive 资源发布日期排序 - 使用说明
 * ============================================================
 *
 * 功能：
 *   - 读取HDHive资源卡片已有的发布日期
 *   - 按发布日期排序资源卡片（最新在前）
 *   - 支持多Tab切换（不同网盘独立排序）
 *
 * 配置：
 *   - 无需配置API Key
 *
 * 适用页面：
 *   - https://hdhive.com/movie/*
 *   - https://hdhive.com/tv/*
 *   - https://hdhive.com/tmdb/movie/*
 *   - https://hdhive.com/tmdb/tv/*
 *
 * 版本历史：
 *   v2.8 - 改为读取页面已有发布日期排序，移除API Key和时间角标
 *   v2.7 - 简化代码，固定使用渐变胶囊样式
 *   v2.6 - 添加样式切换按钮
 *   v2.5 - 添加7种时间标签样式可选
 *   v2.4 - 每次Tab切换都重新排序
 *   v2.3 - 修复重定向后Tab切换失效问题
 *   v2.2 - 添加卡片渲染等待重试机制
 *   v2.1 - 修复Tab切换时时间标签丢失问题
 *
 * ============================================================
 */

// ==UserScript==
// @name         HDHive 资源发布日期排序
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  按HDHive页面已有发布日期排序资源卡片
// @author       You
// @match        https://hdhive.com/movie/*
// @match        https://hdhive.com/tv/*
// @match        https://hdhive.com/tmdb/movie/*
// @match        https://hdhive.com/tmdb/tv/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    let currentUrl = window.location.href;
    let currentSessionId = 0;
    let tabListenersAdded = false;

    function getMediaType() {
        const url = window.location.href;
        if (url.includes('/movie/')) return 'movie';
        if (url.includes('/tv/')) return 'tv';
        return null;
    }

    function getCurrentTabKey() {
        const selectedTab = document.querySelector('.MuiTab-root.Mui-selected');
        if (!selectedTab) return null;
        return selectedTab.textContent;
    }

    function parsePublishedDate(card) {
        const text = card.textContent || '';
        const match = text.match(/发布于\s*(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
        if (!match) return null;

        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const date = new Date(year, month - 1, day);

        if (
            date.getFullYear() !== year ||
            date.getMonth() !== month - 1 ||
            date.getDate() !== day
        ) {
            return null;
        }

        return date.getTime();
    }

    function sortCardsByTime() {
        const tabKey = getCurrentTabKey();
        if (!tabKey) return false;

        const gridContainer = document.querySelector('.MuiGrid-root.MuiGrid-container.MuiGrid-spacing-xs-2');
        if (!gridContainer) return false;

        const cards = Array.from(gridContainer.children).map((card, index) => {
            return {
                card: card,
                index: index,
                time: parsePublishedDate(card)
            };
        });

        if (cards.length === 0) return false;

        const datedCount = cards.filter(item => item.time !== null).length;
        if (datedCount === 0) return false;

        cards.sort((a, b) => {
            if (a.time === null && b.time === null) return a.index - b.index;
            if (a.time === null) return 1;
            if (b.time === null) return -1;
            if (a.time === b.time) return a.index - b.index;
            return b.time - a.time;
        });

        cards.forEach(item => {
            gridContainer.appendChild(item.card);
        });

        console.log(`[HDHive时间] 已按发布日期排序 ${datedCount}/${cards.length} 个卡片（最新在前）`);
        return true;
    }

    function processTab(retryCount = 0, sessionId) {
        if (sessionId !== currentSessionId) return;

        const tabKey = getCurrentTabKey();
        if (!tabKey) {
            if (retryCount < 10 && sessionId === currentSessionId) {
                console.log(`[HDHive时间] 等待Tab渲染... (${retryCount + 1}/10)`);
                setTimeout(() => processTab(retryCount + 1, sessionId), 500);
            }
            return;
        }

        const sorted = sortCardsByTime();

        if (!sorted && retryCount < 10 && sessionId === currentSessionId) {
            console.log(`[HDHive时间] 卡片或发布日期未渲染，等待重试... (${retryCount + 1}/10)`);
            setTimeout(() => processTab(retryCount + 1, sessionId), 500);
            return;
        }
    }

    function addTabListeners() {
        if (tabListenersAdded) return;

        const tabs = document.querySelectorAll('.MuiTab-root');
        if (tabs.length === 0) return;

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                setTimeout(() => {
                    const tabKey = getCurrentTabKey();
                    if (tabKey) {
                        console.log(`[HDHive时间] Tab切换到: ${tabKey}`);
                        processTab(0, currentSessionId);
                    }
                }, 300);
            });
        });

        tabListenersAdded = true;
        console.log(`[HDHive时间] 已添加Tab切换监听器`);
    }

    function ensureTabListeners(retryCount = 0, sessionId) {
        if (sessionId !== currentSessionId || tabListenersAdded) return;

        addTabListeners();
        if (!tabListenersAdded && retryCount < 10 && sessionId === currentSessionId) {
            setTimeout(() => ensureTabListeners(retryCount + 1, sessionId), 500);
        }
    }

    function resetAndRun() {
        currentSessionId++;
        const sessionId = currentSessionId;

        tabListenersAdded = false;

        const mediaType = getMediaType();

        if (!mediaType) {
            console.log('[HDHive时间] 当前页面不是电影/电视剧详情页');
            return;
        }

        console.log('[HDHive时间] 脚本初始化...');
        setTimeout(() => processTab(0, sessionId), 500);
        ensureTabListeners(0, sessionId);
    }

    function watchUrlChange() {
        setInterval(() => {
            if (window.location.href !== currentUrl) {
                console.log('[HDHive时间] 检测到URL变化');
                console.log(`[HDHive时间] 旧URL: ${currentUrl}`);
                console.log(`[HDHive时间] 新URL: ${window.location.href}`);

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
