import AsyncStorage from "@react-native-async-storage/async-storage";
import { isDemoSession } from "@/demo/mode";
import { isIsolatedDemoPreview } from "@/demo/preview";
import { DEMO_HOSTS } from "@/demo/host";

const PREFIX = isDemoSession() ? "vorteo:demo:" : "vorteo:preview-welcome:";
const demoStorage = {
  async getItem(key: string): Promise<string | null> {
    const saved = window.sessionStorage.getItem(PREFIX + key);
    if (saved !== null) return saved;
    // The demo starts with its simulated installation's Host and Dev, so both show while locked.
    if (key === "@paseo:daemon-registry") return JSON.stringify(isDemoSession() ? DEMO_HOSTS : []);
    return null;
  },
  async setItem(key: string, value: string): Promise<void> {
    window.sessionStorage.setItem(PREFIX + key, value);
  },
  async removeItem(key: string): Promise<void> {
    window.sessionStorage.removeItem(PREFIX + key);
  },
};

export default isDemoSession() || isIsolatedDemoPreview ? demoStorage : AsyncStorage;
