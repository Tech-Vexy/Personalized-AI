"use client";

type GetStartedProps = {
  onStart: () => void;
};

export default function GetStarted({ onStart }: GetStartedProps) {
  return (
    <div className="app">
      <header className="app-header">
        <p className="app-title">
          Personal AI <span>· that remembers</span>
        </p>
      </header>

      <main className="get-started">
        <div className="get-started-card">
          <div className="get-started-badge">Local-First · Unified Memory</div>
          <h1 className="get-started-title">A personal AI that actually remembers.</h1>
          <p className="get-started-lead">
            Built for thinkers, builders, and learners. Most chatbots treat every conversation like a
            stranger. This companion builds long-term memory across sessions, directly on your device.
          </p>

          <div className="get-started-features">
            <div className="feature-item">
              <span className="feature-dot" />
              <div>
                <strong>Unified memory across time</strong>
                <p>Prior topics, projects, and decisions resurface when relevant—without per-chat silos.</p>
              </div>
            </div>

            <div className="feature-item">
              <span className="feature-dot" />
              <div>
                <strong>Receipts with thought signatures</strong>
                <p>When the AI recalls past ground, a collapsible receipt shows which session it pulled from and why.</p>
              </div>
            </div>

            <div className="feature-item">
              <span className="feature-dot" />
              <div>
                <strong>No accounts, no cloud</strong>
                <p>Your SQLite database lives locally on your machine. Nothing leaves except direct model requests.</p>
              </div>
            </div>
          </div>

          <button className="get-started-btn" type="button" onClick={onStart}>
            Get Started
          </button>
        </div>
      </main>
    </div>
  );
}
