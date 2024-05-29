import { Storage } from "@plasmohq/storage";
import axios from "axios";
import type { Auth } from "~ts/Auth";

class AuthHandler {
  private token: string | null = null;
  private refresh: string | null = null;
  private storage: Storage;
  private loginStateListeners: LoginListener[] = [];

  constructor() {
    this.storage = new Storage();
    this.load();
  }

  addLoginListener(loginListener) {
    this.loginStateListeners.push(loginListener);
  }

  removeLoginListener(loginListener) {
    this.loginStateListeners = this.loginStateListeners.filter(
      (listener) => listener != loginListener
    );
  }
  

  isLoggedIn() {
    return Boolean(this.token && this.refresh);
  }

  async load() {
    try {
      const auth = (await this.storage.get("__access__")) as Auth;
      if (auth) {
        this.refresh = auth.refresh;
        this.token = auth.access_token;

        if (this.token && this.refresh) {
          this.loginStateListeners.forEach((listener) => {
            listener("login");
          });
        }
      }
    } catch (exc) {
      console.log(exc);
    }
  }

  async setTokens(auth: Auth) {
    this.refresh = auth.refresh;
    this.token = auth.access_token;

    await this.storage.set("__access__", {
      refresh: auth.refresh,
      access_token: auth.access_token,
    });
  }

  async logout() {
    this.token = null;
    this.refresh = null;
    await this.storage.clear();
  }

  getAccessToken() {
    return this.token;
  }

  getRefresh() {
    return this.refresh;
  }

  async refreshToken(): Promise<Auth | null> {
    try {
      const res = await axios.post<Auth>(
        `${process.env.PLASMO_PUBLIC_API_ROUTE}/auth/refresh`,
        {
          refresh: this.getRefresh(),
        },
        {
          headers: {
            Authorization: `Bearer ${this.getAccessToken()}`,
          },
        }
      );

      await this.setTokens(res.data);

      return res.data;
    } catch (exc) {
      this.logout();
      return null;
    }
  }
}

const instance = new AuthHandler();

export default instance;

export type LoginListener = (state: "login" | "logout") => void;
