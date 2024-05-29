import type { PlasmoMessaging } from "@plasmohq/messaging";
import { Storage } from "@plasmohq/storage";
import { createStep, uploadImage } from "~api/step.api";
import type { Guide } from "~ts/Guide";

const storage = new Storage();

const handler: PlasmoMessaging.MessageHandler = async (req, res) => {
  console.log(req.body);
  storage.set("__access__", req.body);
};

export default handler;
