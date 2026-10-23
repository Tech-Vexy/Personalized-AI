import ChatView from "@/components/ChatView";

// Gating (Get Started → Onboarding → ChatView) arrives with slice 5;
// for now the chat renders directly (devpost/checklist.md > slice 2).
export default function Page() {
  return <ChatView />;
}
