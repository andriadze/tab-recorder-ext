import type { PlasmoMessaging } from "@plasmohq/messaging";
import { Storage } from "@plasmohq/storage";
import { createStep, uploadImage } from "~api/step.api";
import type { Guide } from "~ts/Guide";
import { stopRecording } from "~util/stopRecording";


const handler: PlasmoMessaging.MessageHandler = async (req, res) => {
  stopRecording();
};

export default handler;
