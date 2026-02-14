// TypeLens Content Script
// Minimal setup - main functionality is injected via popup.js executeScript

(function() {
    'use strict';

    // Clean up any existing highlights on page load/refresh
    function cleanup() {
        document.querySelectorAll(
            '.wff-highlight-focus, .wff-hover-highlight, .wff-hover-tooltip, .wff-copy-toast, .wff-jump-tooltip'
        ).forEach(el => el.remove());
        document.querySelectorAll('.wff-anchored').forEach(el => {
            el.style.anchorName = '';
            el.classList.remove('wff-anchored');
        });

        // Reset inspector state if active
        if (window.wffInspectorActive) {
            window.wffInspectorActive = false;
            document.body.style.cursor = '';
        }
    }

    // Run cleanup on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', cleanup);
    } else {
        cleanup();
    }

    // Freeze hover state with Alt+F — hover over element, press Alt+F, then open popup
    window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyF' && e.altKey) {
            e.preventDefault();

            // Toggle: if already frozen, unfreeze
            if (window.wffFreezeAbort) {
                // Unfreeze: stop blocking mouse events, remove cloned hover CSS
                window.wffFreezeAbort.abort();
                window.wffFreezeAbort = null;
                const fs = document.getElementById('wff-freeze-style');
                if (fs) fs.remove();
                // Restore original styles
                if (window.wffFrozenElements) {
                    window.wffFrozenElements.forEach(({ el, original, classes }) => {
                        el.className = classes;
                        if (original) el.setAttribute('style', original);
                        else el.removeAttribute('style');
                    });
                    window.wffFrozenElements = null;
                }
                showToast('Unfrozen');
                return;
            }

            // 1. Snapshot hovered elements — capture classes and inline styles before anything changes
            const hovered = [...document.querySelectorAll(':hover')].filter(
                el => el !== document.documentElement && el !== document.body
            );
            const frozen = hovered.map(el => ({
                el,
                original: el.getAttribute('style') || '',
                classes: el.className
            }));

            // 2. Block mouse-leave events so page JS doesn't tear down hover state
            const abort = new AbortController();
            ['mouseout', 'mouseleave', 'pointerout', 'pointerleave'].forEach(evt => {
                document.addEventListener(evt, (e) => {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                }, { capture: true, signal: abort.signal });
            });
            window.wffFreezeAbort = abort;

            // 3. Clone :hover CSS rules into .wff-frozen equivalents
            let hoverCSS = '';
            for (const sheet of document.styleSheets) {
                try {
                    for (const rule of sheet.cssRules) {
                        if (rule.selectorText && rule.selectorText.includes(':hover')) {
                            const newSelector = rule.selectorText.replace(/:hover/g, '.wff-frozen');
                            hoverCSS += `${newSelector} { ${rule.style.cssText} }\n`;
                        }
                    }
                } catch (e) { /* cross-origin */ }
            }

            // 4. Force inline styles on hovered elements AND all their visible descendants
            const forceProps = ['display', 'visibility', 'opacity', 'max-height', 'overflow', 'position', 'z-index'];
            const allFrozen = new Set();
            hovered.forEach(el => {
                // Force on the hovered element itself
                const cs = window.getComputedStyle(el);
                forceProps.forEach(prop => {
                    el.style.setProperty(prop, cs.getPropertyValue(prop), 'important');
                });
                el.classList.add('wff-frozen');
                allFrozen.add(el);

                // Force on all visible descendants — they may depend on :hover CSS from cross-origin sheets
                el.querySelectorAll('*').forEach(child => {
                    if (allFrozen.has(child)) return;
                    const ccs = window.getComputedStyle(child);
                    if (ccs.display === 'none' || ccs.visibility === 'hidden') return;
                    const rect = child.getBoundingClientRect();
                    if (rect.width <= 0 && rect.height <= 0) return;
                    // Snapshot this child too
                    frozen.push({ el: child, original: child.getAttribute('style') || '', classes: child.className });
                    forceProps.forEach(prop => {
                        child.style.setProperty(prop, ccs.getPropertyValue(prop), 'important');
                    });
                    child.classList.add('wff-frozen');
                    allFrozen.add(child);
                });
            });
            window.wffFrozenElements = frozen;

            // 5. Inject cloned hover CSS + disable transitions
            const freezeStyle = document.createElement('style');
            freezeStyle.id = 'wff-freeze-style';
            freezeStyle.textContent = hoverCSS + '\n.wff-frozen, .wff-frozen * { transition: none !important; animation: none !important; }';
            document.head.appendChild(freezeStyle);
            showToast(`Frozen ${frozen.length} elements — open TypeLens`);
        }
    });

    function showToast(msg) {
        document.querySelectorAll('.wff-copy-toast').forEach(el => el.remove());
        const toast = document.createElement('div');
        toast.className = 'wff-copy-toast';
        toast.textContent = msg;
        toast.style.cssText = `
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            background: #1a1a1a; color: white; padding: 10px 20px; border-radius: 10px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px; font-weight: 500; z-index: 1000001;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2); pointer-events: none;
        `;
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; }, 1500);
        setTimeout(() => toast.remove(), 1800);
    }
})();
