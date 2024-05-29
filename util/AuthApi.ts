import axios from "axios";
import AuthHandler from "./AuthHandler";

export const AuthApiClient = axios.create({
    baseURL: process.env.PLASMO_PUBLIC_API_ROUTE
});
// Request interceptor for API calls
AuthApiClient.interceptors.request.use(
  async (config) => {
    config.headers.Authorization = `Bearer ${AuthHandler.getAccessToken()}`;
    return config;
  },
  (error) => {
    Promise.reject(error);
  }
);
// Response interceptor for API calls
AuthApiClient.interceptors.response.use(
  (response) => {
    return response;
  },
  async function (error) {
    const originalRequest = error.config;
    if (error.response.status === 403 && !originalRequest._retry) {
      originalRequest._retry = true;
      const res = await AuthHandler.refreshToken();
      axios.defaults.headers.common["Authorization"] =
        "Bearer " + res?.access_token;
      return AuthApiClient(originalRequest);
    }
    return Promise.reject(error);
  }
);
