import "./loginButton.css";

export function LoginButton() {
  const handleLogin = () => {
    chrome.tabs.create({ url: process.env.PLASMO_PUBLIC_AUTH_ROUTE });
  };
  return (
    <button onClick={handleLogin} className="login-button">
      Log in
    </button>
  );
}
