import type { Step } from "~ts/Step";
import { AuthApiClient } from "~util/AuthApi";
import { dataURItoBlob } from "~util/dataUriToBlob";

export async function createStep(guideId: number, stepInfo: Step) {
  try {
    const stepCreationResp = await AuthApiClient.post("/steps", {
      guideId,
      ...stepInfo,
    });

    return stepCreationResp.data;
  } catch (exc) {
    console.log(exc);

    return null;
  }
}

export async function uploadImage(step: Step, image: string) {
  try {
    const blob = dataURItoBlob(image);
    const formData = new FormData();
    formData.append("file", blob);
    await AuthApiClient.post(`/steps/${step.id}/upload`, formData);
  } catch (exc) {
    return null;
  }
}
