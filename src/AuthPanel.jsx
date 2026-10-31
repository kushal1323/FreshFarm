
import { useState } from "react";
import {
  signIn,
  signUp,
  confirmSignUp,
} from "aws-amplify/auth";

export default function AuthPanel({ onLogin }) {
  const [mode, setMode] = useState("login");
  const [step, setStep] = useState("form");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("buyer");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
const [showPassword, setShowPassword] = useState(false);
  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");

    try {
      if (step === "confirm") {
        await confirmSignUp({
          username: email,
          confirmationCode: code,
        });

        setStep("form");
        setMode("login");

        // A confirmed account can sign in now. The authenticated profile sync
        // uses Cognito's email_verified claim to approve farmer profiles.
        const result = await signIn({ username: email, password });
        if (result.isSignedIn) {
          await onLogin();
          setMessage("Email verified and your account is ready.");
        } else {
          setMessage("Email verified. Sign in to finish setting up your account.");
        }
        return;
      }

      if (mode === "register") {
        const result = await signUp({
          username: email,
          password,
          options: {
            userAttributes: {
              email,
              name: fullName.trim(),
              "custom:role": role,
            },
          },
        });

        if (result.nextStep.signUpStep === "CONFIRM_SIGN_UP") {
          setStep("confirm");
          setMessage("A verification code has been sent to your email.");
        } else {
          setMessage("Registration completed. Please sign in.");
          setMode("login");
        }

        return;
      }

      await signIn({
        username: email,
        password,
      });

      await onLogin();
    } catch (err) {
      setError(err.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>🌱 FreshFarm</h1>
        <p>From farm to home.</p>

        <h2>
          {step === "confirm"
            ? "Verify your email"
            : mode === "login"
              ? "Welcome back"
              : "Create your account"}
        </h2>

        <form onSubmit={handleSubmit}>
          {step === "confirm" ? (
            <label>
              Verification code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                placeholder="Enter email verification code"
              />
            </label>
          ) : (
            <>
              {mode === "register" && (
                <label>
                  Full Name
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                    placeholder="Enter your full name"
                  />
                </label>
              )}

              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                />
              </label>

              <label className="password-field">
  Password

  <div className="password-input-wrapper">
    <input
      type={showPassword ? "text" : "password"}
      value={password}
      onChange={(e) => setPassword(e.target.value)}
      required
      minLength={8}
      placeholder="Enter your password"
    />

    <button
      type="button"
      className="password-toggle"
      onClick={() => setShowPassword((prev) => !prev)}
      aria-label={showPassword ? "Hide password" : "Show password"}
    >
      {showPassword ? "︶" : "👁"}
    </button>
  </div>
</label>

              {mode === "register" && (
                <label>
                  Account type
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    <option value="buyer">Buyer</option>
                    <option value="farmer">Farmer</option>
                  </select>
                </label>
              )}
            </>
          )}

          {error && <p className="auth-error">{error}</p>}
          {message && <p className="auth-message">{message}</p>}

          <button type="submit" disabled={loading}>
            {loading
              ? "Please wait..."
              : step === "confirm"
                ? "Verify account"
                : mode === "login"
                  ? "Sign in"
                  : "Create account"}
          </button>
        </form>

        {step === "form" && (
          <p className="auth-switch">
            {mode === "login"
              ? "New to FreshFarm?"
              : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError("");
                setMessage("");
              }}
            >
              {mode === "login" ? "Register" : "Sign in"}
            </button>
          </p>
        )}
      </section>
    </main>
  );
}
