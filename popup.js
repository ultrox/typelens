document.addEventListener('DOMContentLoaded', async () => {
    const fontList = document.getElementById('font-list');
    const fontCountText = document.getElementById('font-count-text');
    const inspectToggle = document.getElementById('inspect-toggle');

    let currentTab = null;
    let isInspectorActive = false;
    let activeTab = 'typography';
    let cachedFontGroups = null;
    let cachedTypographyGroups = null;
    let lineHeightMode = 'ratio';
    let typoSortMode = 'size';

    // Background detects popup close via port disconnect and runs cleanup
    chrome.runtime.connect({ name: 'popup' });

    init();

    async function init() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            currentTab = tab;

            if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
                showNoAccessMessage();
                return;
            }

            await loadFontData(tab.id);
        } catch (error) {
            console.error('Error initializing popup:', error);
            showErrorMessage();
        }
    }

    async function loadFontData(tabId) {
        try {
            const [fontResults, typoResults] = await Promise.all([
                chrome.scripting.executeScript({
                    target: { tabId },
                    function: detectFontsByElement
                }),
                chrome.scripting.executeScript({
                    target: { tabId },
                    function: detectTypography
                })
            ]);

            cachedFontGroups = fontResults[0].result;
            cachedTypographyGroups = typoResults[0].result;
            renderActiveTab();
        } catch (error) {
            console.error('Error loading font data:', error);
            showErrorMessage();
        }
    }

    function renderActiveTab() {
        if (activeTab === 'fonts') {
            displayFonts(cachedFontGroups);
        } else {
            displayTypography(cachedTypographyGroups);
        }
    }

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.dataset.tab === activeTab) return;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeTab = tab.dataset.tab;
            renderActiveTab();
        });
    });

    function displayFonts(fontGroups) {
        if (!fontGroups || fontGroups.length === 0) {
            fontList.innerHTML = '<div class="no-fonts">No fonts detected on this page</div>';
            fontCountText.textContent = '0 fonts found';
            return;
        }

        fontCountText.textContent = `${fontGroups.length} font${fontGroups.length === 1 ? '' : 's'} found`;

        fontList.innerHTML = fontGroups.map(group => `
            <div class="font-group" data-font="${encodeURIComponent(group.font)}">
                <div class="font-header">
                    <span class="font-name" style="font-family: ${group.font}">${group.displayName}</span>
                    <span class="font-total">${group.totalCount}</span>
                </div>
                <div class="tag-list">
                    ${group.tags.map(tag => `
                        <span class="tag-chip" data-tag="${tag.name}" data-font="${encodeURIComponent(group.font)}">
                            ${tag.name}
                            <span class="tag-count">${tag.count}</span>
                        </span>
                    `).join('')}
                </div>
            </div>
        `).join('');

        // Tag chip click: lock highlight + show copy bar
        document.querySelectorAll('.tag-chip').forEach(chip => {
            chip.addEventListener('click', async (e) => {
                e.stopPropagation();
                const tag = chip.dataset.tag;
                const font = decodeURIComponent(chip.dataset.font);

                const wasActive = chip.classList.contains('active');
                document.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));

                if (!wasActive) {
                    chip.classList.add('active');
                    await highlightAndScrollTo(font, [tag]);
                } else {
                    highlightElements(font, [tag], false);
                }
            });
        });

        // Highlight on tag chip hover
        document.querySelectorAll('.font-group').forEach(group => {
            group.addEventListener('mouseover', (e) => {
                if (document.querySelector('.tag-chip.active')) return;
                const chip = e.target.closest('.tag-chip');
                if (chip) {
                    const font = decodeURIComponent(group.dataset.font);
                    highlightElements(font, [chip.dataset.tag], true);
                }
            });

            group.addEventListener('mouseleave', () => {
                if (document.querySelector('.tag-chip.active')) return;
                const font = decodeURIComponent(group.dataset.font);
                const tags = Array.from(group.querySelectorAll('.tag-chip')).map(c => c.dataset.tag);
                highlightElements(font, tags, false);
            });
        });
    }

    function displayTypography(typoGroups) {
        if (!typoGroups || typoGroups.length === 0) {
            fontList.innerHTML = '<div class="no-fonts">No typography detected on this page</div>';
            fontCountText.textContent = '0 element types found';
            return;
        }

        const totalStyles = typoGroups.reduce((sum, g) => sum + g.styles.length, 0);
        fontCountText.textContent = `${totalStyles} style${totalStyles === 1 ? '' : 's'} across ${typoGroups.length} group${typoGroups.length === 1 ? '' : 's'}`;

        const roundPx = v => {
            const n = parseFloat(v);
            return isNaN(n) ? v : n % 1 === 0 ? `${n}px` : `${+n.toFixed(2)}px`;
        };
        const fmtLineHeight = (lh, size) => {
            if (lineHeightMode === 'original') return roundPx(lh);
            const lhN = parseFloat(lh);
            const sizeN = parseFloat(size);
            if (isNaN(lhN) || isNaN(sizeN) || sizeN === 0) return lh;
            const ratio = lhN / sizeN;
            return ratio % 1 === 0 ? `${ratio}` : `${+ratio.toFixed(2)}`;
        };

        const sorted = typoGroups.map(group => ({
            ...group,
            styles: [...group.styles].sort((a, b) =>
                typoSortMode === 'size' ? parseFloat(b.size) - parseFloat(a.size) : b.count - a.count
            )
        }));

        fontList.innerHTML = `
            <div class="typo-toolbar">
                <div class="typo-options">
                    <span class="typo-options-label">Sort</span>
                    <div class="typo-toggle">
                        <button class="typo-toggle-btn ${typoSortMode === 'size' ? 'active' : ''}" data-group="sort" data-mode="size">Size</button>
                        <button class="typo-toggle-btn ${typoSortMode === 'frequency' ? 'active' : ''}" data-group="sort" data-mode="frequency">Count</button>
                    </div>
                </div>
                <div class="typo-options">
                    <span class="typo-options-label">Line height</span>
                    <div class="typo-toggle">
                        <button class="typo-toggle-btn ${lineHeightMode === 'ratio' ? 'active' : ''}" data-group="lh" data-mode="ratio">Ratio</button>
                        <button class="typo-toggle-btn ${lineHeightMode === 'original' ? 'active' : ''}" data-group="lh" data-mode="original">px</button>
                    </div>
                </div>
            </div>
        ` + sorted.map(group => `
            <div class="typo-group">
                <div class="typo-classifier">${group.classifier}</div>
                ${group.styles.map(style => `
                    <div class="typo-row" data-tag="${style.tag}" data-font="${encodeURIComponent(style.font)}" data-size="${style.size}" data-weight="${style.weight}" data-line-height="${style.lineHeight}">
                        <span class="typo-row-tag">${style.tag}</span>
                        <span class="typo-metrics">${roundPx(style.size)} / ${style.weight} / ${fmtLineHeight(style.lineHeight, style.size)} / ${style.displayName}</span>
                        <span class="typo-count">&times;${style.count}</span>
                    </div>
                `).join('')}
            </div>
        `).join('');

        // Sort mode toggle
        document.querySelectorAll('.typo-toggle-btn[data-group="sort"]').forEach(btn => {
            btn.addEventListener('click', () => {
                typoSortMode = btn.dataset.mode;
                displayTypography(typoGroups);
            });
        });

        // Line height mode toggle
        document.querySelectorAll('.typo-toggle-btn[data-group="lh"]').forEach(btn => {
            btn.addEventListener('click', () => {
                lineHeightMode = btn.dataset.mode;
                displayTypography(typoGroups);
            });
        });

        // Click to highlight matching elements
        document.querySelectorAll('.typo-row').forEach(row => {
            row.addEventListener('click', async () => {
                const wasActive = row.classList.contains('active');
                document.querySelectorAll('.typo-row').forEach(r => r.classList.remove('active'));

                if (!wasActive) {
                    row.classList.add('active');
                    const tag = row.dataset.tag;
                    const font = decodeURIComponent(row.dataset.font);
                    const size = row.dataset.size;
                    const weight = row.dataset.weight;
                    const lineHeight = row.dataset.lineHeight;
                    await highlightTypographyElements(tag, font, size, weight, lineHeight);
                } else {
                    await clearHighlights();
                }
            });
        });
    }

    async function highlightTypographyElements(tag, fontFamily, size, weight, lineHeight) {
        try {
            if (!currentTab) return;
            await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: highlightTypographyMatches,
                args: [tag, fontFamily, size, weight, lineHeight]
            });
        } catch (error) {
            console.error('Error highlighting typography:', error);
        }
    }

    async function clearHighlights() {
        try {
            if (!currentTab) return;
            await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: toggleHighlight,
                args: ['', [], false]
            });
        } catch (error) {
            console.error('Error clearing highlights:', error);
        }
    }

    async function highlightElements(fontFamily, tags, highlight) {
        try {
            if (!currentTab) return;

            await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: toggleHighlight,
                args: [fontFamily, tags, highlight]
            });
        } catch (error) {
            console.error('Error highlighting elements:', error);
        }
    }

    async function highlightAndScrollTo(fontFamily, tags) {
        try {
            if (!currentTab) return;

            await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: highlightAndScroll,
                args: [fontFamily, tags]
            });
        } catch (error) {
            console.error('Error highlighting elements:', error);
        }
    }

    // Inspector toggle
    inspectToggle.addEventListener('click', async () => {
        isInspectorActive = !isInspectorActive;
        inspectToggle.classList.toggle('active', isInspectorActive);

        try {
            if (!currentTab) return;

            if (isInspectorActive) {
                await chrome.scripting.executeScript({
                    target: { tabId: currentTab.id },
                    function: enableInspectorMode
                });
            } else {
                await chrome.scripting.executeScript({
                    target: { tabId: currentTab.id },
                    function: disableInspectorMode
                });
            }
        } catch (error) {
            console.error('Error toggling inspector:', error);
        }
    });

    function showNoAccessMessage() {
        fontList.innerHTML = '<div class="no-fonts">Cannot access this page<br><small>Extension doesn\'t work on Chrome internal pages</small></div>';
        fontCountText.textContent = 'No access';
    }

    function showErrorMessage() {
        fontList.innerHTML = '<div class="no-fonts">Error loading fonts</div>';
        fontCountText.textContent = 'Error';
    }
});

// Content script function: Detects fonts grouped by font family with tag breakdown
function detectFontsByElement() {
    const TAG_PRIORITY = { 'h1': 1, 'h2': 2, 'h3': 3, 'h4': 4, 'h5': 5, 'h6': 6, 'p': 7, 'span': 8, 'a': 9, 'li': 10, 'div': 11 };
    const SEMANTIC = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'label', 'button']);
    const RELEVANT = new Set([...SEMANTIC, 'span', 'div', 'a']);
    const fontMap = new Map();
    const counted = new Set();

    // Walk every visible text node and attribute it to the best ancestor:
    // climb from the text's parent toward the root, preferring semantic tags
    // (h1-h6, p, li …) over wrappers (span, div, a). Stop climbing when
    // the font-family diverges so inner overrides are still captured.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });

    while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (!parent) continue;

        const computedStyle = window.getComputedStyle(parent);
        const fontFamily = computedStyle.fontFamily;
        if (!fontFamily) continue;

        // Visibility checks on the actual text container
        const rect = parent.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (computedStyle.display === 'none') continue;
        if (computedStyle.visibility === 'hidden') continue;
        if (computedStyle.opacity === '0') continue;

        // Walk up to find the best element to attribute this text to
        let target = null;
        let el = parent;
        while (el && el !== document.documentElement) {
            const tag = el.tagName.toLowerCase();
            if (RELEVANT.has(tag)) {
                const elFont = (el === parent) ? fontFamily : window.getComputedStyle(el).fontFamily;
                if (elFont === fontFamily) {
                    target = el;
                    if (SEMANTIC.has(tag)) break;
                } else {
                    break;
                }
            }
            el = el.parentElement;
        }

        if (!target || counted.has(target)) continue;
        counted.add(target);

        const tagName = target.tagName.toLowerCase();

        if (!fontMap.has(fontFamily)) {
            fontMap.set(fontFamily, {
                font: fontFamily,
                displayName: fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
                tagCounts: new Map(),
                totalCount: 0
            });
        }

        const entry = fontMap.get(fontFamily);
        entry.tagCounts.set(tagName, (entry.tagCounts.get(tagName) || 0) + 1);
        entry.totalCount++;
    }

    // Convert to array and format
    const groups = Array.from(fontMap.values()).map(group => {
        const tags = Array.from(group.tagCounts.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => {
                const aPriority = TAG_PRIORITY[a.name] || 999;
                const bPriority = TAG_PRIORITY[b.name] || 999;
                return aPriority - bPriority;
            });

        return {
            font: group.font,
            displayName: group.displayName,
            tags: tags,
            totalCount: group.totalCount
        };
    });

    // Sort groups: those with headings first, then by total count
    groups.sort((a, b) => {
        const aHasHeading = a.tags.some(t => t.name.match(/^h[1-6]$/));
        const bHasHeading = b.tags.some(t => t.name.match(/^h[1-6]$/));

        if (aHasHeading && !bHasHeading) return -1;
        if (!aHasHeading && bHasHeading) return 1;

        return b.totalCount - a.totalCount;
    });

    return groups;
}

// Content script function: Toggle element highlighting
function toggleHighlight(fontFamily, tags, highlight) {
    document.querySelectorAll('.wff-highlight').forEach(el => el.remove());
    document.querySelectorAll('.wff-anchored').forEach(el => {
        el.style.anchorName = '';
        el.classList.remove('wff-anchored');
    });

    if (!highlight) return;

    const selector = tags.join(', ');
    const elements = document.querySelectorAll(selector);
    let i = 0;

    elements.forEach(element => {
        const computedStyle = window.getComputedStyle(element);
        if (computedStyle.fontFamily !== fontFamily) return;
        if (!element.textContent.trim()) return;

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const anchor = `--wff-a-${i++}`;
        element.style.anchorName = anchor;
        element.classList.add('wff-anchored');

        const highlightEl = document.createElement('div');
        highlightEl.className = 'wff-highlight';
        highlightEl.style.cssText = `
            position: absolute;
            position-anchor: ${anchor};
            top: anchor(top);
            left: anchor(left);
            width: anchor-size(width);
            height: anchor-size(height);
            background-color: rgba(0, 122, 204, 0.12);
            border: 2px solid rgba(0, 122, 204, 0.6);
            pointer-events: none;
            z-index: 999999;
            border-radius: 8px;
            box-sizing: border-box;
        `;
        document.body.appendChild(highlightEl);
    });
}

// Content script function: Highlight and scroll to first element
function highlightAndScroll(fontFamily, tags) {
    document.querySelectorAll('.wff-highlight').forEach(el => el.remove());
    document.querySelectorAll('.wff-anchored').forEach(el => {
        el.style.anchorName = '';
        el.classList.remove('wff-anchored');
    });

    const selector = tags.join(', ');
    const elements = document.querySelectorAll(selector);
    let firstElement = null;
    let i = 0;

    elements.forEach(element => {
        const computedStyle = window.getComputedStyle(element);
        if (computedStyle.fontFamily !== fontFamily) return;
        if (!element.textContent.trim()) return;

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        if (!firstElement) {
            firstElement = element;
        }

        const anchor = `--wff-a-${i++}`;
        element.style.anchorName = anchor;
        element.classList.add('wff-anchored');

        const highlightEl = document.createElement('div');
        highlightEl.className = 'wff-highlight';
        highlightEl.style.cssText = `
            position: absolute;
            position-anchor: ${anchor};
            top: anchor(top);
            left: anchor(left);
            width: anchor-size(width);
            height: anchor-size(height);
            background-color: rgba(0, 122, 204, 0.15);
            border: 2px solid rgba(0, 122, 204, 0.7);
            pointer-events: none;
            z-index: 999999;
            border-radius: 6px;
            box-sizing: border-box;
        `;
        document.body.appendChild(highlightEl);
    });

    if (firstElement) {
        firstElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Content script function: Enable inspector mode (self-contained with inline handlers)
function enableInspectorMode() {
    if (window.wffInspectorActive) return;

    window.wffInspectorActive = true;
    window.wffInspectorAbort = new AbortController();
    const signal = window.wffInspectorAbort.signal;
    document.body.style.cursor = 'crosshair';
    function onHover(event) {
        const element = event.target;

        // Remove existing highlights and tooltips
        document.querySelectorAll('.wff-hover-highlight, .wff-hover-tooltip').forEach(el => el.remove());

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        // Create highlight
        const highlight = document.createElement('div');
        highlight.className = 'wff-hover-highlight';
        highlight.style.cssText = `
            position: fixed;
            top: ${rect.top}px;
            left: ${rect.left}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            border: 2px solid #007acc;
            background-color: rgba(0, 122, 204, 0.06);
            pointer-events: none;
            z-index: 999998;
            border-radius: 8px;
            box-sizing: border-box;
        `;
        document.body.appendChild(highlight);

        // Create tooltip
        const computedStyle = window.getComputedStyle(element);
        const fontFamily = computedStyle.fontFamily || 'sans-serif';
        const fontSize = computedStyle.fontSize || '16px';
        const fontWeight = computedStyle.fontWeight || 'normal';
        const fontStyle = computedStyle.fontStyle || 'normal';
        const lineHeight = computedStyle.lineHeight || 'normal';
        const color = computedStyle.color || 'black';
        const cleanFontName = fontFamily.split(',')[0].replace(/['"]/g, '').trim();
        const tagName = element.tagName.toLowerCase();

        const tooltip = document.createElement('div');
        tooltip.className = 'wff-hover-tooltip';
        tooltip.style.cssText = `
            position: fixed;
            background: #ffffff;
            border: none;
            border-radius: 12px;
            padding: 14px 16px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08);
            z-index: 1000000;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 12px;
            line-height: 1.5;
            max-width: 260px;
            pointer-events: none;
            color: #3c3c3c;
        `;

        tooltip.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 8px; color: #007acc; font-size: 13px;">&lt;${tagName}&gt;</div>
            <div style="color: #3c3c3c; margin-bottom: 3px;"><strong style="color: #555;">Font:</strong> ${cleanFontName}</div>
            <div style="color: #3c3c3c; margin-bottom: 3px;"><strong style="color: #555;">Size:</strong> ${fontSize}</div>
            <div style="color: #3c3c3c; margin-bottom: 3px;"><strong style="color: #555;">Weight:</strong> ${fontWeight}</div>
            <div style="color: #3c3c3c; margin-bottom: 3px;"><strong style="color: #555;">Style:</strong> ${fontStyle}</div>
            <div style="color: #3c3c3c; margin-bottom: 3px;"><strong style="color: #555;">Line Height:</strong> ${lineHeight}</div>
            <div style="color: #3c3c3c; margin-bottom: 0;"><strong style="color: #555;">Color:</strong> <span style="display: inline-block; width: 12px; height: 12px; background: ${color}; border-radius: 2px; vertical-align: middle; margin-right: 4px; border: 1px solid #ddd;"></span>${color}</div>
            <div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid #f0f0f0; font-size: 10px; color: #aaa; text-align: center;">Click to copy CSS</div>
        `;

        // Position tooltip
        let top = rect.bottom + 8;
        let left = rect.left;

        if (left + 250 > window.innerWidth) left = window.innerWidth - 260;
        if (left < 10) left = 10;
        if (top + 150 > window.innerHeight) top = rect.top - 158;

        tooltip.style.top = top + 'px';
        tooltip.style.left = left + 'px';

        document.body.appendChild(tooltip);
    }

    function onOut() {
        document.querySelectorAll('.wff-hover-highlight, .wff-hover-tooltip').forEach(el => el.remove());
    }

    function onClick(event) {
        event.preventDefault();
        event.stopPropagation();

        const element = event.target;
        const computedStyle = window.getComputedStyle(element);

        const css = [
            `font-family: ${computedStyle.fontFamily};`,
            `font-size: ${computedStyle.fontSize};`,
            `font-weight: ${computedStyle.fontWeight};`,
            `font-style: ${computedStyle.fontStyle};`,
            `line-height: ${computedStyle.lineHeight};`,
            `color: ${computedStyle.color};`
        ];

        if (computedStyle.letterSpacing !== 'normal') {
            css.push(`letter-spacing: ${computedStyle.letterSpacing};`);
        }

        navigator.clipboard.writeText(css.join('\n'));

        // Show toast feedback
        document.querySelectorAll('.wff-copy-toast').forEach(el => el.remove());
        const toast = document.createElement('div');
        toast.className = 'wff-copy-toast';
        toast.textContent = 'CSS copied!';
        toast.style.cssText = `
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translateX(-50%);
            background: #1a1a1a;
            color: white;
            padding: 10px 20px;
            border-radius: 10px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            font-weight: 500;
            z-index: 1000001;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2);
            pointer-events: none;
            opacity: 1;
            transition: opacity 0.3s ease;
        `;
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; }, 1200);
        setTimeout(() => toast.remove(), 1500);
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            window.wffInspectorActive = false;
            document.body.style.cursor = '';
            if (window.wffInspectorAbort) {
                window.wffInspectorAbort.abort();
                window.wffInspectorAbort = null;
            }
            document.querySelectorAll('.wff-hover-highlight, .wff-hover-tooltip, .wff-copy-toast').forEach(el => el.remove());
        }
    }

    document.addEventListener('mouseover', onHover, { capture: true, signal });
    document.addEventListener('mouseout', onOut, { capture: true, signal });
    document.addEventListener('click', onClick, { capture: true, signal });
    document.addEventListener('keydown', onKeyDown, { capture: true, signal });
}

// Content script function: Disable inspector mode
function disableInspectorMode() {
    if (!window.wffInspectorActive) return;

    window.wffInspectorActive = false;
    document.body.style.cursor = '';

    if (window.wffInspectorAbort) {
        window.wffInspectorAbort.abort();
        window.wffInspectorAbort = null;
    }

    document.querySelectorAll('.wff-hover-highlight, .wff-hover-tooltip, .wff-copy-toast').forEach(el => el.remove());
}

// Content script function: Detect typography grouped by classifier with metric breakdowns
function detectTypography() {
    const TAG_ORDER = { 'h1': 1, 'h2': 2, 'h3': 3, 'h4': 4, 'h5': 5, 'h6': 6, 'p': 7, 'li': 8, 'td': 9, 'th': 10, 'label': 11, 'button': 12, 'a': 13, 'div': 14 };
    const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    const CONTENT = new Set(['p', 'li', 'td', 'th']);
    const INTERACTIVE = new Set(['button', 'a', 'label']);
    const CLASSIFY = tag => HEADINGS.has(tag) ? 'Headings' : CONTENT.has(tag) ? 'Content' : INTERACTIVE.has(tag) ? 'Interactive' : 'Other';
    const CLASSIFIER_ORDER = { 'Headings': 1, 'Content': 2, 'Interactive': 3, 'Other': 4 };

    const SEMANTIC = new Set([...HEADINGS, ...CONTENT, ...INTERACTIVE]);
    const RELEVANT = new Set([...SEMANTIC, 'span', 'div']);
    const counted = new Set();
    const classifierMap = new Map(); // classifier -> Map<key, {tag, font, displayName, size, weight, lineHeight, count}>

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });

    while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (!parent) continue;

        const computedStyle = window.getComputedStyle(parent);
        const fontFamily = computedStyle.fontFamily;
        if (!fontFamily) continue;

        const rect = parent.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (computedStyle.display === 'none') continue;
        if (computedStyle.visibility === 'hidden') continue;
        if (computedStyle.opacity === '0') continue;

        // Walk up to find semantic ancestor
        let target = null;
        let el = parent;
        while (el && el !== document.documentElement) {
            const tag = el.tagName.toLowerCase();
            if (RELEVANT.has(tag)) {
                const elFont = (el === parent) ? fontFamily : window.getComputedStyle(el).fontFamily;
                if (elFont === fontFamily) {
                    target = el;
                    if (SEMANTIC.has(tag)) break;
                } else {
                    break;
                }
            }
            el = el.parentElement;
        }

        if (!target || counted.has(target)) continue;
        counted.add(target);

        const tag = target.tagName.toLowerCase();
        // Skip spans — they're inline wrappers, not distinct typographic decisions
        if (tag === 'span') continue;

        const classifier = CLASSIFY(tag);
        const targetStyle = window.getComputedStyle(target);
        const size = targetStyle.fontSize;
        const weight = targetStyle.fontWeight;
        const lineHeight = targetStyle.lineHeight;
        const displayName = fontFamily.split(',')[0].replace(/['"]/g, '').trim();

        const key = `${tag}|${fontFamily}|${size}|${weight}|${lineHeight}`;

        if (!classifierMap.has(classifier)) {
            classifierMap.set(classifier, new Map());
        }
        const styleMap = classifierMap.get(classifier);
        if (!styleMap.has(key)) {
            styleMap.set(key, { tag, font: fontFamily, displayName, size, weight, lineHeight, count: 0 });
        }
        styleMap.get(key).count++;
    }

    // Convert to sorted array of classifier groups
    const groups = Array.from(classifierMap.entries()).map(([classifier, styleMap]) => ({
        classifier,
        styles: Array.from(styleMap.values()).sort((a, b) => {
            const tagDiff = (TAG_ORDER[a.tag] || 999) - (TAG_ORDER[b.tag] || 999);
            return tagDiff !== 0 ? tagDiff : b.count - a.count;
        })
    }));

    groups.sort((a, b) => CLASSIFIER_ORDER[a.classifier] - CLASSIFIER_ORDER[b.classifier]);

    // Drop empty "Other" if semantic tags covered everything
    return groups.filter(g => g.styles.length > 0);
}

// Content script function: Highlight elements matching a specific typography combination
function highlightTypographyMatches(tag, fontFamily, size, weight, lineHeight) {
    document.querySelectorAll('.wff-highlight').forEach(el => el.remove());
    document.querySelectorAll('.wff-anchored').forEach(el => {
        el.style.anchorName = '';
        el.classList.remove('wff-anchored');
    });

    const elements = document.querySelectorAll(tag);
    let firstElement = null;
    let i = 0;

    elements.forEach(element => {
        const cs = window.getComputedStyle(element);
        if (cs.fontFamily !== fontFamily) return;
        if (cs.fontSize !== size) return;
        if (cs.fontWeight !== weight) return;
        if (cs.lineHeight !== lineHeight) return;
        if (!element.textContent.trim()) return;

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        if (!firstElement) firstElement = element;

        const anchor = `--wff-a-${i++}`;
        element.style.anchorName = anchor;
        element.classList.add('wff-anchored');

        const highlightEl = document.createElement('div');
        highlightEl.className = 'wff-highlight';
        highlightEl.style.cssText = `
            position: absolute;
            position-anchor: ${anchor};
            top: anchor(top);
            left: anchor(left);
            width: anchor-size(width);
            height: anchor-size(height);
            background-color: rgba(0, 122, 204, 0.15);
            border: 2px solid rgba(0, 122, 204, 0.7);
            pointer-events: none;
            z-index: 999999;
            border-radius: 6px;
            box-sizing: border-box;
        `;
        document.body.appendChild(highlightEl);
    });

    if (firstElement) {
        firstElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}
