export function dataURItoBlob(dataURI) {
  var byteStr;
  if (dataURI.split(",")[0].indexOf("base64") >= 0)
    byteStr = atob(dataURI.split(",")[1]);
  else byteStr = unescape(dataURI.split(",")[1]);

  var mimeStr = dataURI.split(",")[0].split(":")[1].split(";")[0];

  var arr = new Uint8Array(byteStr.length);
  for (var i = 0; i < byteStr.length; i++) {
    arr[i] = byteStr.charCodeAt(i);
  }

  return new Blob([arr], { type: mimeStr });
}
