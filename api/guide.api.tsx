import { AuthApiClient } from "~util/AuthApi";

export async function startRecordingApi() {
  try {
    const res = await AuthApiClient.post("/guides", {});

    return res.data;
  } catch (err) {
    console.log(err);
    return null;
  }
}

export async function stopRecordingApi(guideId: number) {
  try {
    const res = await AuthApiClient.post(`/guides/${guideId}`, {
      active: false,
    });

    return res.data;
  } catch (err) {
    console.log(err);
    return null;
  }
}
