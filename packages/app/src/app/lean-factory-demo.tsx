import { Redirect } from "expo-router";
import { LeanFactoryDemoScreen } from "@/screens/factory/lean/lean-demo-screen";

/** Development builds only: lean Factory views on demo data. Production redirects home. */
export default function LeanFactoryDemoRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <LeanFactoryDemoScreen />;
}
