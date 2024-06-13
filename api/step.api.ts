import type { Step } from "~ts/Step";
import fetchWithAuth from "~util/AuthApi";
import { dataURItoBlob } from "~util/dataUriToBlob";

export async function createStep(guideId: number, stepInfo: Step) {
  try {
    const stepCreationResp = await fetchWithAuth("/steps", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        guideId,
        ...stepInfo,
      }),
    });

    const json = await stepCreationResp.json();

    return json;
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
    const res = await fetchWithAuth(`/steps/${step.id}/upload`, {
      method: "POST",
      body: formData,
    });

    const json = res.json();
    console.log(json);
  } catch (exc) {
    console.log(exc);
    return null;
  }
}
