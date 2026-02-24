// function that simply clicks the "accept"/"run"/"retry" buttons

import * as utils from './utils.js';


// high level wrapper of click() with constraints
export function autoAccept(buttons) {
    utils.assert(Array.isArray(buttons), "buttons must be an array")

    let targetSelectors = []
    let panelSelector = null

    // Antigravity buttons
    if (buttons.includes("accept") || buttons.includes("retry")) {
        targetSelectors.push(".bg-ide-button-background", "button")
        panelSelector = "#antigravity\\.agentPanel"
    }

    utils.assert(targetSelectors.length > 0, "no target selectors found")
    return click(targetSelectors, panelSelector)
}


// basic sanity checks before clicking
function isAcceptButton(el) {
    if (!el || !el.textContent) return false;

    const text = el.textContent.trim();
    if (text.length === 0 || text.length > 50) return false;

    // Use centralized pattern matching from utils.js
    if (!utils.matchesLegacyAcceptPattern(text)) return false;

    // Reject if matches negative pattern
    if (utils.matchesLegacyRejectPattern(text)) return false;

    // State validation using centralized function
    return utils.isElementVisibleAndClickable(el);
}





export function focusOnPanel(panelSelector) {
    if (!panelSelector) return
    const docs = getDocuments();
    for (const doc of docs) {
        const panel = doc.querySelector(panelSelector)
        if (panel) {
            panel.focus()
            break
        }
    }
}
