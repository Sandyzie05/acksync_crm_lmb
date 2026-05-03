import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

type ErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

class AppErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || "The application ran into an unexpected error.",
    };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Unhandled application error", error, errorInfo);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <main
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            padding: "32px",
            background: "#f8f1e6",
            color: "#342117",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <section
            style={{
              maxWidth: "720px",
              padding: "28px",
              borderRadius: "24px",
              background: "#fffaf5",
              boxShadow: "0 20px 50px rgba(77, 43, 24, 0.12)",
            }}
          >
            <h1 style={{ marginTop: 0 }}>Acksync CRM hit an unexpected error</h1>
            <p style={{ lineHeight: 1.6 }}>
              The window stayed open so you can recover instead of losing the whole app session.
            </p>
            <p style={{ lineHeight: 1.6 }}>
              <strong>Error:</strong> {this.state.message}
            </p>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
