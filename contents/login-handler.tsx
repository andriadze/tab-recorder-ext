import { sendToBackground } from "@plasmohq/messaging";
import type { PlasmoCSConfig } from "plasmo";

export const config: PlasmoCSConfig = {
  matches: [
    "http://localhost:5173/*",
    "https://dolphin-app-f75yi.ondigitalocean.app/*",
  ],
  all_frames: true,
};

let access_token, refresh;

const auth = localStorage.getItem("__access__");
if (auth) {
  const authObj = JSON.parse(auth);
  access_token = authObj.access_token;
  refresh = authObj.access_token;

  sendToBackground({
    name: "handle-login",
    body: {
      access_token: authObj.access_token,
      refresh: authObj.refresh,
    },
  });
}

setInterval(() => {
  const auth = localStorage.getItem("__access__");
  if (!auth && access_token) {
    sendToBackground({
      name: "handle-login",
      body: {
        access_token: null,
        refresh: null,
      },
    });
  } else if (auth) {
    const authObj = JSON.parse(auth);
    access_token = authObj.access_token;
    refresh = authObj.access_token;

    sendToBackground({
      name: "handle-login",
      body: {
        access_token: authObj.access_token,
        refresh: authObj.refresh,
      },
    });
  }
}, 5000);
