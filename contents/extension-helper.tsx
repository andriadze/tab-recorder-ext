import { sendToBackground } from "@plasmohq/messaging";
import type { PlasmoCSConfig } from "plasmo";

export const config: PlasmoCSConfig = {
  matches: [
    "http://localhost:5173/*",
    "https://www.guidemagic.ai/*",
    "https://app.guidemagic.ai/*",
  ],
};

setTimeout(function() {
  /* Example: Send data from the page to your Chrome extension */
  document.dispatchEvent(new CustomEvent('$$_guidemagic_extension_present_$$', {}));
}, 0);