import fetchWithAuth from "~util/AuthApi";

export async function startRecordingApi() {
  try {
    const res = await fetchWithAuth("/guides", {
      method: "POST",
    });

    const json = await res.json();

    return json;
  } catch (err) {
    console.log(err);
    return null;
  }
}

export async function stopRecordingApi(guideId: number) {
  try {
    const res = await fetchWithAuth(`/guides/${guideId}/stop`, {
      method: "POST",
    });

    const json = await res.json();

    return json;
  } catch (err) {
    console.log(err);
    return null;
  }
}
