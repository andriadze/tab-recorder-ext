import AuthHandler from "./AuthHandler";

const baseURL = process.env.PLASMO_PUBLIC_API_ROUTE;

const fetchWithAuth = async (url: string, options: RequestInit) => {
  // Add the Authorization header to the request
  const accessToken = await AuthHandler.getAccessToken();
  options.headers = {
    ...options.headers,
    Authorization: `Bearer ${accessToken}`,
  };

  console.log("Fetching", url, options);
  const fetchWithRetry = async () => {
    const response = await fetch(baseURL + url, options);
    if (response.status === 403 || response.status === 401) {
      const res = await AuthHandler.refreshToken();
      options.headers["Authorization"] = `Bearer ${res?.access_token}`;
      return fetch(baseURL + url, options);
    }
    return response;
  };

  try {
    const response = await fetchWithRetry();
    if (response.status >= 400 && response.status < 600) {
      throw new Error("Bad response from server");
    }
    return response;
  } catch (error) {
    console.log(error);
    return Promise.reject(error);
  }
};

export default fetchWithAuth;
