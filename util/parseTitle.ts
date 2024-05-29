export default function parseTitle(elem: any) {
  if (elem.defaultValue) {
    return elem.value;
  } else if (elem.ariaLabel) {
    return elem.ariaLabel;
  } else if (elem.innerText) {
    return elem.innerText;
  } else if(elem.placeholder) {
    return elem.placeholder
  } else {
    return "";
  }
}
