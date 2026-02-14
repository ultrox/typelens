document.addEventListener('DOMContentLoaded', async () => {
    const fontList = document.getElementById('font-list');
    const fontCountText = document.getElementById('font-count-text');
    const inspectToggle = document.getElementById('inspect-toggle');
    const freezeToggle = document.getElementById('freeze-toggle');
    const searchInput = document.getElementById('search-input');

    let currentTab = null;
    let isInspectorActive = false;
    let isFrozen = false;
    let cachedTypographyGroups = null;
    let lineHeightMode = 'ratio';
    let typoSortMode = 'size';
    let displayAbort = null;

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

            // Check if page was frozen before popup opened
            try {
                const [result] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    function: () => !!(window.wffFrozenElements || window.wffFreezeAbort)
                });
                if (result.result) {
                    isFrozen = true;
                    freezeToggle.classList.add('active');
                }
            } catch (e) { /* ignore */ }

            await loadFontData(tab.id);
        } catch (error) {
            console.error('Error initializing popup:', error);
            showErrorMessage();
        }
    }

    async function loadFontData(tabId) {
        try {
            const [typoResults, fontFaceResults] = await Promise.all([
                chrome.scripting.executeScript({
                    target: { tabId },
                    function: detectTypography
                }),
                chrome.scripting.executeScript({
                    target: { tabId },
                    function: extractFontFaces
                })
            ]);

            cachedTypographyGroups = typoResults[0].result;

            const fontFaceCSS = fontFaceResults[0].result;
            if (fontFaceCSS) {
                const style = document.createElement('style');
                style.textContent = fontFaceCSS;
                document.head.appendChild(style);
            }

            displayTypography(cachedTypographyGroups);
        } catch (error) {
            console.error('Error loading font data:', error);
            showErrorMessage();
        }
    }

    function formatStyles(allStyles, format) {
        if (format === 'css') {
            return allStyles.map(s => {
                const lines = [`/* ${s.tag} */`];
                lines.push(`font-family: ${s.fontFamily};`);
                if (s.fontStyle !== 'normal') lines.push(`font-style: ${s.fontStyle};`);
                lines.push(`font-weight: ${s.fontWeight};`);
                lines.push(`font-size: ${s.fontSize};`);
                lines.push(`line-height: ${s.lineHeight};`);
                lines.push(`letter-spacing: ${s.letterSpacing};`);
                lines.push(`text-transform: ${s.textTransform};`);
                lines.push(`color: ${s.color};`);
                return lines.join('\n');
            }).join('\n\n');
        }

        const camelCase = (s) => s.trim().split(/\s+/).map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
        const numKey = (v) => { const n = parseFloat(v); return isNaN(n) ? v : String(n % 1 === 0 ? Math.round(n) : +n.toFixed(2)); };
        const letterSpacingNames = {
            '0px': '0', 'normal': '0',
            '0.5px': 'half', '-0.5px': 'minus-half',
            '1px': '1', '-1px': 'minus-1',
            '1.5px': '1-half', '-1.5px': 'minus-1-half',
            '2px': '2', '-2px': 'minus-2'
        };

        const groups = {
            'font-family': {},
            'font-weight': {},
            'font-size': {},
            'line-height': {},
            'letter-spacing': {},
            'text-transform': {}
        };
        allStyles.forEach(s => {
            const cleanFont = s.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
            const lsKey = letterSpacingNames[s.letterSpacing] || numKey(s.letterSpacing);
            groups['font-family'][camelCase(cleanFont)] = { type: 'string', value: cleanFont };
            groups['font-weight'][String(s.fontWeight)] = { type: 'dimension', value: s.fontWeight };
            groups['font-size'][numKey(s.fontSize)] = { type: 'dimension', value: s.fontSize };
            groups['line-height'][numKey(s.lineHeight)] = { type: 'dimension', value: s.lineHeight };
            groups['letter-spacing'][lsKey] = { type: 'dimension', value: s.letterSpacing };
            groups['text-transform'][s.textTransform] = { type: 'string', value: s.textTransform };
        });

        const j = (v) => JSON.stringify(v);
        const lines = ['{'];
        const groupKeys = Object.keys(groups);
        groupKeys.forEach((gk, gi) => {
            lines.push(`  ${j(gk)}: {`);
            const entries = Object.entries(groups[gk]).sort(([a], [b]) => {
                const na = parseFloat(a), nb = parseFloat(b);
                if (!isNaN(na) && !isNaN(nb)) return na - nb;
                return a.localeCompare(b);
            });
            entries.forEach(([k, v], i) => {
                const comma = i < entries.length - 1 ? ',' : '';
                lines.push(`    ${j(k)}: { "type": ${j(v.type)}, "value": ${j(v.value)} }${comma}`);
            });
            lines.push(gi < groupKeys.length - 1 ? '  },' : '  }');
        });
        lines.push('}');
        return lines.join('\n');
    }

    function collectDescriptors(container) {
        const descriptors = [];
        container.querySelectorAll('.typo-row-check input:checked').forEach(cb => {
            const row = cb.closest('.typo-row');
            if (!row) return;
            descriptors.push({
                tag: row.dataset.tag,
                font: decodeURIComponent(row.dataset.font),
                size: row.dataset.size,
                weight: row.dataset.weight,
                lineHeight: row.dataset.lineHeight,
                textTransform: row.dataset.textTransform,
                letterSpacing: row.dataset.letterSpacing
            });
        });
        return descriptors;
    }

    function exitAllCopyMode() {
        fontList.classList.remove('copy-mode-all');
        delete fontList.dataset.copyFormat;
        fontList.querySelectorAll('.typo-all-copy-pill.active').forEach(p => p.classList.remove('active'));
        fontList.querySelectorAll('.typo-group').forEach(g => {
            g.classList.remove('copy-mode');
            delete g.dataset.copyFormat;
            g.querySelectorAll('.typo-group-copy-pill.active').forEach(p => p.classList.remove('active'));
        });
        fontList.querySelectorAll('.typo-row-check input').forEach(cb => { cb.checked = true; });
        const copyBtn = fontList.querySelector('.typo-all-copy-btn');
        if (copyBtn) copyBtn.remove();
    }

    function displayTypography(typoGroups) {
        // Abort previous event listeners to prevent stacking
        if (displayAbort) displayAbort.abort();
        displayAbort = new AbortController();
        const signal = displayAbort.signal;

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

        const TAG_ORDER = { 'h1': 1, 'h2': 2, 'h3': 3, 'h4': 4, 'h5': 5, 'h6': 6, 'p': 7, 'li': 8, 'td': 9, 'th': 10, 'button': 11, 'a': 12, 'label': 13, 'div': 14 };
        const sorted = typoGroups.map(group => ({
            ...group,
            styles: [...group.styles].sort((a, b) => {
                const tagDiff = (TAG_ORDER[a.tag] || 999) - (TAG_ORDER[b.tag] || 999);
                if (tagDiff !== 0) return tagDiff;
                return typoSortMode === 'size' ? parseFloat(b.size) - parseFloat(a.size) : b.count - a.count;
            })
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
                <div class="typo-options">
                    <span class="typo-options-label">Copy all</span>
                    <div class="typo-classifier-actions">
                        <button class="typo-all-copy-pill" data-format="css">CSS</button>
                        <button class="typo-all-copy-pill" data-format="tokens">Tokens</button>
                    </div>
                </div>
            </div>
        ` + sorted.map(group => `
            <div class="typo-group">
                <div class="typo-classifier">
                    <span>${group.classifier}</span>
                    <div class="typo-classifier-actions">
                        <button class="typo-group-copy-pill" data-format="css">CSS</button>
                        <button class="typo-group-copy-pill" data-format="tokens">Tokens</button>
                        <button class="typo-preview-toggle">Preview</button>
                    </div>
                </div>
                ${group.styles.map(style => {
                    const previewFont = style.font.replace(/"/g, "'");
                    const previewSize = Math.min(parseFloat(style.size), 16);
                    const escapedSample = (style.sample || 'The quick brown fox').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    const metricsStr = `${roundPx(style.size)} / ${style.weight} / ${fmtLineHeight(style.lineHeight, style.size)} / ${style.displayName}`;
                    const dataAttrs = `data-tag="${style.tag}" data-font="${encodeURIComponent(style.font)}" data-size="${style.size}" data-weight="${style.weight}" data-line-height="${style.lineHeight}" data-text-transform="${style.textTransform}" data-letter-spacing="${style.letterSpacing}"`;
                    const samplesAttr = (style.samples || []).join('|||').replace(/"/g, '&quot;').toLowerCase();
                    return `
                    <div class="typo-row-group" data-samples="${samplesAttr}">
                    <div class="typo-row" ${dataAttrs}>
                        <label class="typo-row-check"><input type="checkbox" checked></label>
                        <span class="typo-row-tag">${style.tag}</span>
                        <span class="typo-metrics">${metricsStr}</span>
                        <button class="typo-count" ${dataAttrs}>&times;${style.count}<span class="typo-chevron">&#x203A;</span></button>
                    </div>
                    <div class="typo-preview typo-preview-row" style="font-family: ${previewFont}; font-size: ${previewSize}px; font-weight: ${style.weight}; line-height: ${style.lineHeight}; font-style: ${style.fontStyle}; text-transform: ${style.textTransform}; letter-spacing: ${style.letterSpacing}"><button class="typo-jump-btn" ${dataAttrs} data-element-index="0"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg></button><span class="typo-preview-text">${escapedSample}</span></div>
                    </div>`;
                }).join('')}
            </div>
        `).join('');

        // Restore copy mode state after re-render
        if (fontList.classList.contains('copy-mode-all')) {
            const format = fontList.dataset.copyFormat;
            fontList.querySelectorAll('.typo-group').forEach(g => {
                g.classList.add('copy-mode');
                g.dataset.copyFormat = format;
                const gPill = g.querySelector(`.typo-group-copy-pill[data-format="${format}"]`);
                if (gPill) gPill.classList.add('active');
            });
            const allPill = fontList.querySelector(`.typo-all-copy-pill[data-format="${format}"]`);
            if (allPill) allPill.classList.add('active');
            const count = fontList.querySelectorAll('.typo-row-check input:checked').length;
            const btn = document.createElement('button');
            btn.className = 'typo-all-copy-btn';
            btn.textContent = `COPY (${count})`;
            fontList.appendChild(btn);
        }

        // Populate datalist with all text samples
        const datalist = document.getElementById('search-suggestions');
        const seen = new Set();
        let options = '';
        typoGroups.forEach(g => g.styles.forEach(s => {
            (s.samples || []).forEach(t => {
                if (t && !seen.has(t)) { seen.add(t); options += `<option value="${t.replace(/"/g, '&quot;')}">`; }
            });
        }));
        datalist.innerHTML = options;

        // Re-apply search filter after re-render
        if (searchInput.value.trim()) {
            searchInput.dispatchEvent(new Event('input'));
        }

        const listen = (evt, fn) => fontList.addEventListener(evt, fn, { signal });

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

        // Preview toggle per card
        document.querySelectorAll('.typo-preview-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const group = btn.closest('.typo-group');
                group.classList.toggle('show-preview');
                btn.classList.toggle('active');

                if (!group.classList.contains('show-preview')) {
                    group.querySelectorAll('.typo-preview-instance').forEach(el => el.remove());
                    group.querySelectorAll('.typo-count.expanded').forEach(b => b.classList.remove('expanded'));
                    group.querySelectorAll('.typo-row-sticky').forEach(r => r.classList.remove('typo-row-sticky'));
                    group.querySelectorAll('.typo-preview-active').forEach(el => el.classList.remove('typo-preview-active'));
                    group.querySelectorAll('.typo-copy-actions').forEach(el => el.remove());
                }
            });
        });

        // Group copy pill click handler (event delegation)
        listen('click', (e) => {
            const pill = e.target.closest('.typo-group-copy-pill');
            if (!pill) return;
            e.stopPropagation();

            const group = pill.closest('.typo-group');

            // During all-copy mode, group pills toggle their group on/off
            if (fontList.classList.contains('copy-mode-all')) {
                const format = fontList.dataset.copyFormat;
                if (pill.dataset.format !== format) return;

                if (group.classList.contains('copy-mode')) {
                    // Toggle group OFF — uncheck all rows, deactivate pill
                    group.classList.remove('copy-mode');
                    pill.classList.remove('active');
                    group.querySelectorAll('.typo-row-check input').forEach(cb => { cb.checked = false; });
                } else {
                    // Toggle group ON — check all rows, activate pill
                    group.classList.add('copy-mode');
                    pill.classList.add('active');
                    group.querySelectorAll('.typo-row-check input').forEach(cb => { cb.checked = true; });
                }
                // Update all-copy button count
                const count = fontList.querySelectorAll('.typo-row-check input:checked').length;
                const allBtn = fontList.querySelector('.typo-all-copy-btn');
                if (allBtn) {
                    allBtn.textContent = `COPY (${count})`;
                    allBtn.disabled = count === 0;
                }
                return;
            }

            const wasActive = pill.classList.contains('active');

            // If clicking a different format pill while already in copy mode, switch format
            const activePill = group.querySelector('.typo-group-copy-pill.active');
            if (activePill && activePill !== pill) {
                activePill.classList.remove('active');
                pill.classList.add('active');
                group.dataset.copyFormat = pill.dataset.format;
                return;
            }

            if (wasActive) {
                // Exit copy mode
                group.classList.remove('copy-mode');
                delete group.dataset.copyFormat;
                pill.classList.remove('active');
                group.querySelectorAll('.typo-row-check input').forEach(cb => { cb.checked = true; });
                const copyBtn = group.querySelector('.typo-group-copy-btn');
                if (copyBtn) copyBtn.remove();
            } else {
                // Enter copy mode
                group.classList.add('copy-mode');
                group.dataset.copyFormat = pill.dataset.format;
                pill.classList.add('active');
                const count = group.querySelectorAll('.typo-row-check input:checked').length;
                const btn = document.createElement('button');
                btn.className = 'typo-group-copy-btn';
                btn.textContent = `COPY (${count})`;
                group.appendChild(btn);
            }
        });

        // Checkbox change handler — update copy button count (group or all)
        listen('change', (e) => {
            if (!e.target.closest('.typo-row-check')) return;

            // All-groups mode
            if (fontList.classList.contains('copy-mode-all')) {
                const count = fontList.querySelectorAll('.typo-row-check input:checked').length;
                const btn = fontList.querySelector('.typo-all-copy-btn');
                if (btn) {
                    btn.textContent = `COPY (${count})`;
                    btn.disabled = count === 0;
                }
                return;
            }

            // Per-group mode
            const group = e.target.closest('.typo-group');
            if (!group || !group.classList.contains('copy-mode')) return;
            const count = group.querySelectorAll('.typo-row-check input:checked').length;
            const btn = group.querySelector('.typo-group-copy-btn');
            if (btn) {
                btn.textContent = `COPY (${count})`;
                btn.disabled = count === 0;
            }
        });

        // Group copy button click handler
        listen('click', async (e) => {
            const btn = e.target.closest('.typo-group-copy-btn');
            if (!btn) return;
            e.stopPropagation();

            const group = btn.closest('.typo-group');
            const activePill = group.querySelector('.typo-group-copy-pill.active');
            const format = activePill ? activePill.dataset.format : 'css';
            const descriptors = collectDescriptors(group);
            if (descriptors.length === 0) return;

            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: currentTab.id },
                    function: getGroupStyles,
                    args: [descriptors]
                });
                const text = formatStyles(results[0].result || [], format);
                await navigator.clipboard.writeText(text);

                const ghost = document.createElement('span');
                ghost.className = 'typo-copy-ghost';
                ghost.textContent = 'Copied!';
                btn.style.position = 'relative';
                btn.appendChild(ghost);
                ghost.addEventListener('animationend', () => ghost.remove());

                // Exit copy mode
                group.classList.remove('copy-mode');
                delete group.dataset.copyFormat;
                group.querySelectorAll('.typo-group-copy-pill.active').forEach(p => p.classList.remove('active'));
                group.querySelectorAll('.typo-row-check input').forEach(cb => { cb.checked = true; });
                btn.remove();
            } catch (error) {
                console.error('Error copying group styles:', error);
            }
        });

        // All-groups copy pill click handler
        listen('click', (e) => {
            const pill = e.target.closest('.typo-all-copy-pill');
            if (!pill) return;
            e.stopPropagation();

            const wasActive = pill.classList.contains('active');

            // Switch format if different pill active
            const activePill = fontList.querySelector('.typo-all-copy-pill.active');
            if (activePill && activePill !== pill) {
                activePill.classList.remove('active');
                pill.classList.add('active');
                fontList.dataset.copyFormat = pill.dataset.format;
                fontList.querySelectorAll('.typo-group').forEach(g => {
                    g.dataset.copyFormat = pill.dataset.format;
                    g.querySelectorAll('.typo-group-copy-pill.active').forEach(p => p.classList.remove('active'));
                    if (g.classList.contains('copy-mode')) {
                        const gPill = g.querySelector(`.typo-group-copy-pill[data-format="${pill.dataset.format}"]`);
                        if (gPill) gPill.classList.add('active');
                    }
                });
                return;
            }

            if (wasActive) {
                exitAllCopyMode();
            } else {
                // Exit any per-group copy mode first
                fontList.querySelectorAll('.typo-group.copy-mode').forEach(g => {
                    g.classList.remove('copy-mode');
                    delete g.dataset.copyFormat;
                    g.querySelectorAll('.typo-group-copy-pill.active').forEach(p => p.classList.remove('active'));
                    g.querySelectorAll('.typo-row-check input').forEach(cb => { cb.checked = true; });
                    const b = g.querySelector('.typo-group-copy-btn');
                    if (b) b.remove();
                });

                fontList.classList.add('copy-mode-all');
                fontList.dataset.copyFormat = pill.dataset.format;
                pill.classList.add('active');
                fontList.querySelectorAll('.typo-group').forEach(g => {
                    g.classList.add('copy-mode');
                    g.dataset.copyFormat = pill.dataset.format;
                    const gPill = g.querySelector(`.typo-group-copy-pill[data-format="${pill.dataset.format}"]`);
                    if (gPill) gPill.classList.add('active');
                });
                const count = fontList.querySelectorAll('.typo-row-check input:checked').length;
                const btn = document.createElement('button');
                btn.className = 'typo-all-copy-btn';
                btn.textContent = `COPY (${count})`;
                fontList.appendChild(btn);
            }
        });

        // All-groups copy button click handler
        listen('click', async (e) => {
            const btn = e.target.closest('.typo-all-copy-btn');
            if (!btn) return;
            e.stopPropagation();

            const format = fontList.dataset.copyFormat || 'css';
            const descriptors = collectDescriptors(fontList);
            if (descriptors.length === 0) return;

            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: currentTab.id },
                    function: getGroupStyles,
                    args: [descriptors]
                });
                const text = formatStyles(results[0].result || [], format);
                await navigator.clipboard.writeText(text);

                const ghost = document.createElement('span');
                ghost.className = 'typo-copy-ghost';
                ghost.textContent = 'Copied!';
                btn.style.position = 'relative';
                btn.appendChild(ghost);
                ghost.addEventListener('animationend', () => ghost.remove());

                exitAllCopyMode();
            } catch (error) {
                console.error('Error copying all styles:', error);
            }
        });

        // Click row to highlight matching elements on page
        document.querySelectorAll('.typo-row').forEach(row => {
            row.addEventListener('click', async (e) => {
                if (e.target.closest('.typo-row-check')) return;
                const wasActive = row.classList.contains('active');
                document.querySelectorAll('.typo-row').forEach(r => r.classList.remove('active'));
                document.querySelectorAll('.typo-row-sticky').forEach(r => r.classList.remove('typo-row-sticky'));

                if (!wasActive) {
                    row.classList.add('active');
                    const tag = row.dataset.tag;
                    const font = decodeURIComponent(row.dataset.font);
                    const size = row.dataset.size;
                    const weight = row.dataset.weight;
                    const lineHeight = row.dataset.lineHeight;
                    const textTransform = row.dataset.textTransform;
                    const letterSpacing = row.dataset.letterSpacing;
                    await highlightTypographyElements(tag, font, size, weight, lineHeight, textTransform, letterSpacing);
                } else {
                    await clearHighlights();
                }
            });
        });

        // Hover row to highlight matching elements on page
        let hoverHighlightActive = false;
        document.querySelectorAll('.typo-row').forEach(row => {
            row.addEventListener('mouseenter', async () => {
                if (row.classList.contains('active')) return;
                hoverHighlightActive = true;
                const tag = row.dataset.tag;
                const font = decodeURIComponent(row.dataset.font);
                const size = row.dataset.size;
                const weight = row.dataset.weight;
                const lineHeight = row.dataset.lineHeight;
                const textTransform = row.dataset.textTransform;
                const letterSpacing = row.dataset.letterSpacing;
                await highlightTypographyElements(tag, font, size, weight, lineHeight, textTransform, letterSpacing);
            });
            row.addEventListener('mouseleave', async () => {
                if (!hoverHighlightActive) return;
                hoverHighlightActive = false;
                // Only clear if no row is click-selected
                if (!document.querySelector('.typo-row.active')) {
                    await clearHighlights();
                } else {
                    // Restore the click-selected row's highlight
                    const active = document.querySelector('.typo-row.active');
                    const tag = active.dataset.tag;
                    const font = decodeURIComponent(active.dataset.font);
                    const size = active.dataset.size;
                    const weight = active.dataset.weight;
                    const lineHeight = active.dataset.lineHeight;
                    const textTransform = active.dataset.textTransform;
                    const letterSpacing = active.dataset.letterSpacing;
                    await highlightTypographyElements(tag, font, size, weight, lineHeight, textTransform, letterSpacing);
                }
            });
        });

        // Click count button to expand/collapse all instances
        document.querySelectorAll('.typo-count').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const row = btn.closest('.typo-row');
                const group = row.closest('.typo-group');

                // Auto-enable preview mode on this card if not already
                if (!group.classList.contains('show-preview')) {
                    group.classList.add('show-preview');
                    group.querySelector('.typo-preview-toggle').classList.add('active');
                }

                const wasExpanded = btn.classList.contains('expanded');
                // Collapse any previously expanded (globally for sticky, within group for the rest)
                fontList.querySelectorAll('.typo-row-sticky').forEach(r => r.classList.remove('typo-row-sticky'));
                group.querySelectorAll('.typo-preview-instance').forEach(el => el.remove());
                group.querySelectorAll('.typo-count.expanded').forEach(b => b.classList.remove('expanded'));
                group.querySelectorAll('.typo-preview-active').forEach(el => el.classList.remove('typo-preview-active'));
                group.querySelectorAll('.typo-copy-actions').forEach(el => el.remove());

                if (!wasExpanded) {
                    btn.classList.add('expanded');
                    row.classList.add('typo-row-sticky');

                    // Select the row and highlight on page
                    document.querySelectorAll('.typo-row.active').forEach(r => r.classList.remove('active'));
                    row.classList.add('active');
                    const tag = btn.dataset.tag;
                    const font = decodeURIComponent(btn.dataset.font);
                    const size = btn.dataset.size;
                    const weight = btn.dataset.weight;
                    const lineHeight = btn.dataset.lineHeight;
                    const textTransform = btn.dataset.textTransform;
                    const letterSpacing = btn.dataset.letterSpacing;
                    await highlightTypographyElements(tag, font, size, weight, lineHeight, textTransform, letterSpacing);

                    // Scroll row to top of font-list
                    const listRect = fontList.getBoundingClientRect();
                    const rowRect = row.getBoundingClientRect();
                    fontList.scrollBy({ top: rowRect.top - listRect.top - 14, behavior: 'smooth' });
                    const preview = row.nextElementSibling;
                    if (preview && preview.classList.contains('typo-preview')) {
                        const results = await chrome.scripting.executeScript({
                            target: { tabId: currentTab.id },
                            function: getTypographySamples,
                            args: [tag, font, size, weight, lineHeight, textTransform, letterSpacing]
                        });
                        let samples = results[0].result || [];

                        // Filter by search query if active
                        const searchQuery = searchInput.value.trim().toLowerCase();
                        if (searchQuery) {
                            samples = samples.filter(s => s.text.toLowerCase().includes(searchQuery));
                        }

                        // Update base preview jump button index and text
                        const baseBtn = preview.querySelector('.typo-jump-btn');
                        if (baseBtn && samples.length > 0) {
                            baseBtn.dataset.elementIndex = samples[0].index;
                            const previewText = preview.querySelector('.typo-preview-text');
                            if (previewText) previewText.textContent = samples[0].text;
                        }

                        // Update count badge to reflect filtered count
                        if (searchQuery) {
                            btn.innerHTML = `&times;${samples.length}<span class="typo-chevron">&#x203A;</span>`;
                        }

                        let insertAfter = preview;
                        samples.slice(1).forEach(sample => {
                            const el = document.createElement('div');
                            el.className = 'typo-preview typo-preview-instance typo-preview-row';
                            el.style.cssText = preview.style.cssText;
                            el.style.display = 'flex';
                            const jumpBtn = document.createElement('button');
                            jumpBtn.className = 'typo-jump-btn';
                            jumpBtn.dataset.tag = tag;
                            jumpBtn.dataset.font = btn.dataset.font;
                            jumpBtn.dataset.size = size;
                            jumpBtn.dataset.weight = weight;
                            jumpBtn.dataset.lineHeight = lineHeight;
                            jumpBtn.dataset.textTransform = textTransform;
                            jumpBtn.dataset.letterSpacing = letterSpacing;
                            jumpBtn.dataset.elementIndex = sample.index;
                            jumpBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>';
                            const span = document.createElement('span');
                            span.className = 'typo-preview-text';
                            span.textContent = sample.text;
                            el.appendChild(jumpBtn);
                            el.appendChild(span);
                            insertAfter.after(el);
                            insertAfter = el;
                        });
                    }
                }
            });
        });

        // Jump button click handler (event delegation)
        listen('click', async (e) => {
            const jumpBtn = e.target.closest('.typo-jump-btn');
            if (!jumpBtn) return;
            e.stopPropagation();

            const previewLine = jumpBtn.closest('.typo-preview');
            const wasActive = previewLine && previewLine.classList.contains('typo-preview-active');

            // Deselect any previously active preview line
            fontList.querySelectorAll('.typo-preview-active').forEach(el => el.classList.remove('typo-preview-active'));
            fontList.querySelectorAll('.typo-copy-actions').forEach(el => el.remove());

            if (wasActive) {
                // Deselect: just clear the focused highlight on the page
                await clearFocusHighlight();
                return;
            }

            // Select this preview line
            if (previewLine) previewLine.classList.add('typo-preview-active');

            const tag = jumpBtn.dataset.tag;
            const font = decodeURIComponent(jumpBtn.dataset.font);
            const size = jumpBtn.dataset.size;
            const weight = jumpBtn.dataset.weight;
            const lineHeight = jumpBtn.dataset.lineHeight;
            const textTransform = jumpBtn.dataset.textTransform;
            const letterSpacing = jumpBtn.dataset.letterSpacing;
            const elementIndex = parseInt(jumpBtn.dataset.elementIndex, 10);

            // Ensure group highlights are shown first
            const row = previewLine && previewLine.closest('.typo-group').querySelector(`.typo-row[data-tag="${tag}"][data-size="${size}"][data-weight="${weight}"][data-text-transform="${textTransform}"][data-letter-spacing="${letterSpacing}"]`);
            if (row && !row.classList.contains('active')) {
                document.querySelectorAll('.typo-row').forEach(r => r.classList.remove('active'));
                row.classList.add('active');
                await highlightTypographyElements(tag, font, size, weight, lineHeight, textTransform, letterSpacing);
            }

            await scrollToElement(tag, font, size, weight, lineHeight, textTransform, letterSpacing, elementIndex);

            // Fetch element styles and show copy pills
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: currentTab.id },
                    function: getElementStyles,
                    args: [tag, font, size, weight, lineHeight, textTransform, letterSpacing, elementIndex]
                });
                const styles = results[0].result;
                if (styles && previewLine) {
                    // Remove any existing copy actions
                    fontList.querySelectorAll('.typo-copy-actions').forEach(el => el.remove());
                    const actions = document.createElement('div');
                    actions.className = 'typo-copy-actions';
                    const copyIcon = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" style="margin-right:3px;vertical-align:-1px"><rect x="5" y="1" width="10" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 4H2.5A1.5 1.5 0 001 5.5v9A1.5 1.5 0 002.5 16h7a1.5 1.5 0 001.5-1.5V14" stroke="currentColor" stroke-width="1.5"/></svg>';
                    actions.innerHTML = `<button class="typo-copy-pill" data-format="css">${copyIcon}CSS</button><button class="typo-copy-pill" data-format="tokens">${copyIcon}Tokens</button>`;
                    actions._styles = styles;
                    previewLine.appendChild(actions);
                }
            } catch (error) {
                console.error('Error fetching styles:', error);
            }
        });

        // Copy pill click handler (event delegation)
        listen('click', async (e) => {
            const pill = e.target.closest('.typo-copy-pill');
            if (!pill) return;
            e.stopPropagation();

            const styles = pill.closest('.typo-copy-actions')._styles;
            if (!styles) return;

            let text;
            if (pill.dataset.format === 'css') {
                const lines = [
                    `font-family: ${styles.fontFamily};`,
                    `font-weight: ${styles.fontWeight};`,
                    `font-size: ${styles.fontSize};`,
                    `line-height: ${styles.lineHeight};`,
                    `letter-spacing: ${styles.letterSpacing};`,
                    `text-transform: ${styles.textTransform};`,
                    `color: ${styles.color};`
                ];
                if (styles.fontStyle !== 'normal') lines.splice(1, 0, `font-style: ${styles.fontStyle};`);
                text = lines.join('\n');
            } else {
                const cleanFont = styles.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
                const camelCase = (s) => s.trim().split(/\s+/).map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
                const numKey = (v) => parseFloat(v) || v;
                const letterSpacingNames = {
                    '0px': '0', 'normal': '0',
                    '0.5px': 'half', '-0.5px': 'minus-half',
                    '1px': '1', '-1px': 'minus-1',
                    '1.5px': '1-half', '-1.5px': 'minus-1-half',
                    '2px': '2', '-2px': 'minus-2'
                };
                const lsValue = styles.letterSpacing;
                const lsKey = letterSpacingNames[lsValue] || numKey(lsValue);
                const j = (v) => JSON.stringify(v);
                text = `{
  // family
  ${j(camelCase(cleanFont))}: { "type": "string", "value": ${j(cleanFont)} },
  // weight
  ${j(String(styles.fontWeight))}: { "type": "dimension", "value": ${j(styles.fontWeight)} },
  // size
  ${j(String(numKey(styles.fontSize)))}: { "type": "dimension", "value": ${j(styles.fontSize)} },
  // line-height
  ${j(String(numKey(styles.lineHeight)))}: { "type": "dimension", "value": ${j(styles.lineHeight)} },
  // letter-spacing
  ${j(String(lsKey))}: { "type": "dimension", "value": ${j(lsValue)} },
  // text-transform
  ${j(styles.textTransform)}: { "type": "string", "value": ${j(styles.textTransform)} }
}`;
            }

            await navigator.clipboard.writeText(text);
            const ghost = document.createElement('span');
            ghost.className = 'typo-copy-ghost';
            ghost.style.color = getComputedStyle(pill).color;
            ghost.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none"><rect x="5" y="1" width="10" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 4H2.5A1.5 1.5 0 001 5.5v9A1.5 1.5 0 002.5 16h7a1.5 1.5 0 001.5-1.5V14" stroke="currentColor" stroke-width="1.5"/></svg>';
            pill.style.position = 'relative';
            pill.insertBefore(ghost, pill.firstChild);
            ghost.addEventListener('animationend', () => ghost.remove());
        });
    }

    async function highlightTypographyElements(tag, fontFamily, size, weight, lineHeight, textTransform, letterSpacing) {
        try {
            if (!currentTab) return;
            await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: highlightTypographyMatches,
                args: [tag, fontFamily, size, weight, lineHeight, textTransform, letterSpacing]
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
                function: () => {
                    document.querySelectorAll('.wff-jump-tooltip').forEach(el => el.remove());
                    document.querySelectorAll('.wff-anchored').forEach(el => {
                        el.style.outline = '';
                        el.style.outlineOffset = '';
                        el.style.boxShadow = '';
                        el.style.borderRadius = '';
                        el.style.anchorName = '';
                        el.classList.remove('wff-anchored', 'wff-focused');
                    });
                }
            });
        } catch (error) {
            console.error('Error clearing highlights:', error);
        }
    }

    async function scrollToElement(tag, fontFamily, size, weight, lineHeight, textTransform, letterSpacing, elementIndex) {
        try {
            if (!currentTab) return;
            await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: scrollToTypographyElement,
                args: [tag, fontFamily, size, weight, lineHeight, textTransform, letterSpacing, elementIndex]
            });
        } catch (error) {
            console.error('Error scrolling to element:', error);
        }
    }

    async function clearFocusHighlight() {
        try {
            if (!currentTab) return;
            await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: clearFocusedHighlight
            });
        } catch (error) {
            console.error('Error clearing focus highlight:', error);
        }
    }

    // Text search filter
    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        const rowGroups = fontList.querySelectorAll('.typo-row-group');
        const groups = fontList.querySelectorAll('.typo-group');

        // Remove previous match lines
        fontList.querySelectorAll('.typo-search-match').forEach(el => el.remove());

        rowGroups.forEach(rg => {
            const countBtn = rg.querySelector('.typo-count');
            if (!query) {
                rg.style.display = '';
                // Restore original count
                if (countBtn && countBtn.dataset.originalCount) {
                    countBtn.innerHTML = `&times;${countBtn.dataset.originalCount}<span class="typo-chevron">&#x203A;</span>`;
                    delete countBtn.dataset.originalCount;
                }
                return;
            }
            const allSamples = (rg.dataset.samples || '').split('|||');
            const matches = allSamples.filter(s => s.includes(query));
            rg.style.display = matches.length ? '' : 'none';

            // Update count badge to show filtered count
            if (matches.length && countBtn) {
                if (!countBtn.dataset.originalCount) {
                    countBtn.dataset.originalCount = allSamples.length;
                }
                countBtn.innerHTML = `&times;${matches.length}<span class="typo-chevron">&#x203A;</span>`;
            }

            // Show matching text snippets below the row (grouped with count)
            if (matches.length) {
                const counts = new Map();
                matches.forEach(m => counts.set(m, (counts.get(m) || 0) + 1));
                const matchList = document.createElement('div');
                matchList.className = 'typo-search-match';
                counts.forEach((count, text) => {
                    const line = document.createElement('span');
                    line.className = 'typo-search-match-text';
                    line.textContent = count > 1 ? `${text} ×${count}` : text;
                    matchList.appendChild(line);
                });
                rg.appendChild(matchList);
            }
        });

        // Hide classifier groups where all rows are hidden
        groups.forEach(group => {
            const visible = group.querySelectorAll('.typo-row-group:not([style*="display: none"])');
            group.style.display = visible.length ? '' : 'none';
        });

        // Update count
        if (query) {
            const totalMatches = fontList.querySelectorAll('.typo-search-match-text').length;
            const visibleRows = fontList.querySelectorAll('.typo-row-group:not([style*="display: none"])');
            fontCountText.textContent = `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${visibleRows.length} style${visibleRows.length === 1 ? '' : 's'}`;
        } else {
            const totalStyles = fontList.querySelectorAll('.typo-row-group').length;
            const typoGroups = fontList.querySelectorAll('.typo-group');
            fontCountText.textContent = `${totalStyles} style${totalStyles === 1 ? '' : 's'} across ${typoGroups.length} group${typoGroups.length === 1 ? '' : 's'}`;
        }
    });

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

    // Freeze toggle — unfreeze and re-scan, or show hint
    freezeToggle.addEventListener('click', async () => {
        try {
            if (!currentTab) return;

            // Check if page is currently frozen
            const [result] = await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: () => !!(window.wffFrozenElements || window.wffFreezeAbort)
            });
            isFrozen = result.result;

            if (isFrozen) {
                // Unfreeze and re-scan
                await chrome.scripting.executeScript({
                    target: { tabId: currentTab.id },
                    function: unfreezeHoverState
                });
                isFrozen = false;
                freezeToggle.classList.remove('active');
                await loadFontData(currentTab.id);
            } else {
                // Can't freeze from popup (mouse already left page)
                // Show hint to use keyboard shortcut
                freezeToggle.classList.add('hint');
                setTimeout(() => freezeToggle.classList.remove('hint'), 2000);
            }
        } catch (error) {
            console.error('Error toggling freeze:', error);
        }
    });

    function showNoAccessMessage() {
        fontList.innerHTML = '<div class="no-fonts">Cannot access this page<br><small>Extension doesn\'t work on Chrome internal pages</small></div>';
        fontCountText.textContent = 'No access';
    }

    function showErrorMessage() {
        fontList.innerHTML = '<div class="no-fonts">Error loading typography</div>';
        fontCountText.textContent = 'Error';
    }
});

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
        const letterSpacing = computedStyle.letterSpacing || 'normal';
        const textTransform = computedStyle.textTransform || 'none';
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
            line-height: 1;
            max-width: 280px;
            pointer-events: none;
            color: #3c3c3c;
        `;

        const gridStyle = 'display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: baseline;';
        const labelStyle = 'color: #999; font-size: 11px; white-space: nowrap;';
        const valueStyle = 'color: #333; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

        const rows = `
            <span style="${labelStyle}">Font</span><span style="${valueStyle}">${cleanFontName}</span>
            <span style="${labelStyle}">Weight</span><span style="${valueStyle}">${fontWeight}</span>
            <span style="${labelStyle}">Size</span><span style="${valueStyle}">${fontSize}</span>
            <span style="${labelStyle}">Line Height</span><span style="${valueStyle}">${lineHeight}</span>
            <span style="${labelStyle}">Letter Spacing</span><span style="${valueStyle}">${letterSpacing}</span>
            <span style="${labelStyle}">Text Transform</span><span style="${valueStyle}">${textTransform}</span>
            <span style="${labelStyle}">Color</span><span style="${valueStyle}"><span style="display: inline-block; width: 10px; height: 10px; background: ${color}; border-radius: 2px; vertical-align: middle; margin-right: 4px; border: 1px solid #ddd;"></span>${color}</span>`;

        tooltip.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 10px; color: #007acc; font-size: 13px;">&lt;${tagName}&gt;</div>
            <div style="${gridStyle}">${rows}</div>
            <div style="margin-top: 10px; padding-top: 6px; border-top: 1px solid #f0f0f0; font-size: 10px; color: #aaa; text-align: center;">Click to copy CSS</div>
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

        if (computedStyle.textTransform !== 'none') {
            css.push(`text-transform: ${computedStyle.textTransform};`);
        }
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
    const counted = new Map(); // element -> Set of keys already counted
    const classifierMap = new Map();

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

        if (!target) continue;

        const tag = target.tagName.toLowerCase();
        if (tag === 'span') continue;

        // Capture ALL metrics from the text's direct parent (actual rendered styles)
        const classifier = CLASSIFY(tag);
        const size = computedStyle.fontSize;
        const weight = computedStyle.fontWeight;
        const lineHeight = computedStyle.lineHeight;
        const fontStyle = computedStyle.fontStyle;
        const textTransform = computedStyle.textTransform;
        const letterSpacing = computedStyle.letterSpacing;
        const displayName = fontFamily.split(',')[0].replace(/['"]/g, '').trim();

        const key = `${tag}|${fontFamily}|${size}|${weight}|${lineHeight}|${textTransform}|${letterSpacing}`;

        // Dedup: same target element counted once per unique style key
        if (!counted.has(target)) counted.set(target, new Set());
        const targetKeys = counted.get(target);
        if (targetKeys.has(key)) continue;
        targetKeys.add(key);

        if (!classifierMap.has(classifier)) {
            classifierMap.set(classifier, new Map());
        }
        const styleMap = classifierMap.get(classifier);
        if (!styleMap.has(key)) {
            const sample = walker.currentNode.textContent.trim().slice(0, 60);
            styleMap.set(key, { tag, font: fontFamily, displayName, size, weight, lineHeight, fontStyle, textTransform, letterSpacing, count: 0, sample, samples: [sample] });
        } else {
            const snippet = walker.currentNode.textContent.trim().slice(0, 60);
            const entry = styleMap.get(key);
            if (entry.samples.length < 200) entry.samples.push(snippet);
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

// Content script function: Get text samples from all elements matching a typography style
function getTypographySamples(tag, fontFamily, size, weight, lineHeight, textTransform, letterSpacing) {
    const elements = document.querySelectorAll(tag);
    const samples = [];
    let index = 0;
    elements.forEach(element => {
        if (!element.textContent.trim()) return;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const tw = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
            acceptNode: n => n.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        });
        let matchedText = null;
        while (tw.nextNode()) {
            const cs = window.getComputedStyle(tw.currentNode.parentElement);
            if (cs.fontFamily === fontFamily && cs.fontSize === size && cs.fontWeight === weight && cs.lineHeight === lineHeight && cs.textTransform === textTransform && cs.letterSpacing === letterSpacing) {
                matchedText = tw.currentNode.textContent.trim().slice(0, 60);
                break;
            }
        }
        if (matchedText) {
            samples.push({ text: matchedText, index });
            index++;
        }
    });
    return samples;
}

// Content script function: Extract @font-face rules from page stylesheets
function extractFontFaces() {
    const rules = [];
    for (const sheet of document.styleSheets) {
        try {
            const baseURL = sheet.href || document.baseURI;
            for (const rule of sheet.cssRules) {
                if (rule instanceof CSSFontFaceRule) {
                    let cssText = rule.cssText;
                    // Resolve relative font URLs to absolute so they work in the popup context
                    cssText = cssText.replace(/url\(["']?([^"')]+)["']?\)/g, (match, url) => {
                        if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) {
                            return match;
                        }
                        try {
                            return `url("${new URL(url, baseURL).href}")`;
                        } catch (e) {
                            return match;
                        }
                    });
                    rules.push(cssText);
                }
            }
        } catch (e) { /* cross-origin stylesheet, skip */ }
    }
    return rules.join('\n');
}

// Content script function: Highlight elements matching a specific typography combination
function highlightTypographyMatches(tag, fontFamily, size, weight, lineHeight, textTransform, letterSpacing) {
    document.querySelectorAll('.wff-jump-tooltip').forEach(el => el.remove());
    document.querySelectorAll('.wff-anchored').forEach(el => {
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.style.boxShadow = '';
        el.style.borderRadius = '';
        el.style.anchorName = '';
        el.classList.remove('wff-anchored', 'wff-focused');
    });

    const elements = document.querySelectorAll(tag);
    let firstElement = null;
    let i = 0;

    elements.forEach(element => {
        if (!element.textContent.trim()) return;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        // Walk text nodes to check if any match the target styles
        const tw = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
            acceptNode: n => n.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        });
        let matched = false;
        while (tw.nextNode()) {
            const cs = window.getComputedStyle(tw.currentNode.parentElement);
            if (cs.fontFamily === fontFamily && cs.fontSize === size && cs.fontWeight === weight && cs.lineHeight === lineHeight && cs.textTransform === textTransform && cs.letterSpacing === letterSpacing) {
                matched = true;
                break;
            }
        }
        if (!matched) return;

        if (!firstElement) firstElement = element;

        element.classList.add('wff-anchored');
        element.style.outline = '2px solid rgba(0, 122, 204, 0.7)';
        element.style.outlineOffset = '-2px';
        element.style.boxShadow = 'inset 0 0 0 1000px rgba(0, 122, 204, 0.12)';
        element.style.borderRadius = '6px';
    });

    if (firstElement) {
        firstElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Content script function: Scroll to and highlight a specific element with a distinct focus style
function scrollToTypographyElement(tag, fontFamily, size, weight, lineHeight, textTransform, letterSpacing, elementIndex) {
    // Remove previous focus highlight and tooltip
    document.querySelectorAll('.wff-jump-tooltip').forEach(el => el.remove());
    document.querySelectorAll('.wff-focused').forEach(el => {
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.style.boxShadow = '';
        el.style.borderRadius = '';
        el.classList.remove('wff-focused');
    });

    const elements = document.querySelectorAll(tag);
    let i = 0;
    let target = null;

    elements.forEach(element => {
        if (!element.textContent.trim()) return;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const tw = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
            acceptNode: n => n.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        });
        let matched = false;
        while (tw.nextNode()) {
            const cs = window.getComputedStyle(tw.currentNode.parentElement);
            if (cs.fontFamily === fontFamily && cs.fontSize === size && cs.fontWeight === weight && cs.lineHeight === lineHeight && cs.textTransform === textTransform && cs.letterSpacing === letterSpacing) {
                matched = true;
                break;
            }
        }
        if (!matched) return;

        if (i === elementIndex) target = element;
        i++;
    });

    if (!target) return;

    // Mark as anchored for cleanup tracking
    if (!target.classList.contains('wff-anchored')) {
        target.classList.add('wff-anchored');
    }

    target.classList.add('wff-focused');
    target.style.outline = '2px solid rgba(255, 149, 0, 0.9)';
    target.style.outlineOffset = '-2px';
    target.style.boxShadow = 'inset 0 0 0 1000px rgba(255, 149, 0, 0.12)';
    target.style.borderRadius = '6px';
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Show inspector tooltip on the target element
    const cs = window.getComputedStyle(target);
    const cleanFont = (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim();
    const tagName = target.tagName.toLowerCase();
    const color = cs.color || 'black';

    const labelStyle = 'color: #999; font-size: 11px; white-space: nowrap;';
    const valueStyle = 'color: #333; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

    const tooltip = document.createElement('div');
    tooltip.className = 'wff-jump-tooltip';
    tooltip.style.cssText = `
        position: fixed;
        background: #ffffff;
        border: none;
        border-radius: 12px;
        padding: 14px 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08);
        z-index: 1000001;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        line-height: 1;
        max-width: 280px;
        pointer-events: none;
        color: #3c3c3c;
    `;
    tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 10px; color: #007acc; font-size: 13px;">&lt;${tagName}&gt;</div>
        <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: baseline;">
            <span style="${labelStyle}">Font</span><span style="${valueStyle}">${cleanFont}</span>
            <span style="${labelStyle}">Weight</span><span style="${valueStyle}">${cs.fontWeight}</span>
            <span style="${labelStyle}">Size</span><span style="${valueStyle}">${cs.fontSize}</span>
            <span style="${labelStyle}">Line Height</span><span style="${valueStyle}">${cs.lineHeight}</span>
            <span style="${labelStyle}">Letter Spacing</span><span style="${valueStyle}">${cs.letterSpacing}</span>
            <span style="${labelStyle}">Text Transform</span><span style="${valueStyle}">${cs.textTransform}</span>
            <span style="${labelStyle}">Color</span><span style="${valueStyle}"><span style="display: inline-block; width: 10px; height: 10px; background: ${color}; border-radius: 2px; vertical-align: middle; margin-right: 4px; border: 1px solid #ddd;"></span>${color}</span>
        </div>
    `;

    // Position tooltip below or above the element
    const rect = target.getBoundingClientRect();
    let top = rect.bottom + 8;
    let left = rect.left;
    if (left + 280 > window.innerWidth) left = window.innerWidth - 290;
    if (left < 10) left = 10;
    if (top + 180 > window.innerHeight) top = rect.top - 188;
    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';

    document.body.appendChild(tooltip);
}

// Content script function: Remove only the focused highlight and tooltip
function clearFocusedHighlight() {
    document.querySelectorAll('.wff-jump-tooltip').forEach(el => el.remove());
    document.querySelectorAll('.wff-focused').forEach(el => {
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.style.boxShadow = '';
        el.style.borderRadius = '';
        el.classList.remove('wff-focused');
    });
}

// Content script function: Get computed style properties of a matched element
function getElementStyles(tag, fontFamily, size, weight, lineHeight, textTransform, letterSpacing, elementIndex) {
    const elements = document.querySelectorAll(tag);
    let i = 0;
    let target = null;

    elements.forEach(element => {
        if (!element.textContent.trim()) return;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const tw = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
            acceptNode: n => n.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        });
        let matched = false;
        while (tw.nextNode()) {
            const cs = window.getComputedStyle(tw.currentNode.parentElement);
            if (cs.fontFamily === fontFamily && cs.fontSize === size && cs.fontWeight === weight && cs.lineHeight === lineHeight && cs.textTransform === textTransform && cs.letterSpacing === letterSpacing) {
                matched = true;
                break;
            }
        }
        if (!matched) return;
        if (i === elementIndex) target = element;
        i++;
    });

    if (!target) return null;

    const cs = window.getComputedStyle(target);
    return {
        fontFamily: cs.fontFamily,
        fontWeight: cs.fontWeight,
        fontSize: cs.fontSize,
        fontStyle: cs.fontStyle,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        textTransform: cs.textTransform,
        color: cs.color
    };
}

// Content script function: Batch fetch computed styles for multiple style descriptors
function getGroupStyles(descriptors) {
    return descriptors.map(d => {
        const elements = document.querySelectorAll(d.tag);
        let target = null;

        for (const element of elements) {
            if (!element.textContent.trim()) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;

            const tw = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
                acceptNode: n => n.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
            });
            let matched = false;
            while (tw.nextNode()) {
                const cs = window.getComputedStyle(tw.currentNode.parentElement);
                if (cs.fontFamily === d.font && cs.fontSize === d.size && cs.fontWeight === d.weight && cs.lineHeight === d.lineHeight && cs.textTransform === d.textTransform && cs.letterSpacing === d.letterSpacing) {
                    matched = true;
                    break;
                }
            }
            if (matched) { target = element; break; }
        }

        if (!target) return null;

        const cs = window.getComputedStyle(target);
        return {
            tag: d.tag,
            fontFamily: cs.fontFamily,
            fontWeight: cs.fontWeight,
            fontSize: cs.fontSize,
            fontStyle: cs.fontStyle,
            lineHeight: cs.lineHeight,
            letterSpacing: cs.letterSpacing,
            textTransform: cs.textTransform,
            color: cs.color
        };
    }).filter(Boolean);
}

// Content script function: Unfreeze hover state, restore original inline styles
function unfreezeHoverState() {
    if (window.wffFreezeAbort) {
        window.wffFreezeAbort.abort();
        window.wffFreezeAbort = null;
    }
    if (window.wffFrozenElements) {
        window.wffFrozenElements.forEach(({ el, original, classes }) => {
            if (classes !== undefined) el.className = classes;
            else el.classList.remove('wff-frozen');
            if (original) el.setAttribute('style', original);
            else el.removeAttribute('style');
        });
        window.wffFrozenElements = null;
    }
    const freezeStyle = document.getElementById('wff-freeze-style');
    if (freezeStyle) freezeStyle.remove();
}
