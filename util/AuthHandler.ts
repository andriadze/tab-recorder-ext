import { Storage } from "@plasmohq/storage";
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

  async getAccessToken() {
    if(!this.token){
      await this.load()
    }
    return this.token;
  }

  async getRefresh() {
    if(!this.token){
      await this.load()
    }

    return this.refresh;
  }

  async refreshToken(): Promise<Auth | null> {
    try {
      const token = await this.getAccessToken();
      const refresh = await this.getRefresh()
      const res = await fetch(
        `${process.env.PLASMO_PUBLIC_API_ROUTE}/auth/refresh`,
        {
          method: "POST",
          body: JSON.stringify({
            refresh,
          }),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );
      const json = (await res.json()) as Auth;

      await this.setTokens(json);

      return json;
    } catch (exc) {
      this.logout();
      return null;
    }
  }
}

const instance = new AuthHandler();

export default instance;

export type LoginListener = (state: "login" | "logout") => void;
