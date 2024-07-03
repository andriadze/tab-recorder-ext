import type { PlasmoMessaging } from "@plasmohq/messaging";
import { Storage } from "@plasmohq/storage";
import { createStep, uploadImage } from "~api/step.api";
import type { Guide } from "~ts/Guide";

const storage = new Storage();

const handler: PlasmoMessaging.MessageHandler = async (req, res) => {
  console.log("Handingling screenshot");
  await chrome.tabs.captureVisibleTab(null, {}, async function (image) {
    console.log("Tab captured!");
    const currGuide = await storage.get<Guide>("guide");
    if (!currGuide.active) {
      return;
    }
    const step = await createStep(currGuide.id, req.body);

    console.log("Image maybe missing", step);
    if (!image) {
      return;
    }

    const newGuide: Guide = {
      ...currGuide,
      stepCount: currGuide.stepCount + 1 || 1,
    };
    await storage.set("guide", newGuide);

    console.log("Calling upload image", step, image);
    await uploadImage(step, image);
    res.send({
      img: image,
    });
  });
};

export default handler;
