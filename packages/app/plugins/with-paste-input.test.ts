import { describe, expect, it } from "vitest";

const {
  configurePasteInputAppDelegate,
  configurePasteInputBridgingHeader,
  configurePasteInputPodfile,
} = require("./with-paste-input");

const sceneTemplate = `internal import Expo
import React
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  var window: UIWindow?
  var reactNativeFactory: RCTReactNativeFactory?
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let factory = ExpoReactNativeFactory(delegate: ReactNativeDelegate())
    reactNativeFactory = factory
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}`;

describe("withPasteInput", () => {
  it("starts one Expo scene runtime with preserved launch options before registering paste", () => {
    const configured = configurePasteInputAppDelegate(sceneTemplate);
    expect(configured).toContain("class PaseoSceneDelegate: ExpoAppSceneDelegate");
    expect(configured.match(/factory.startReactNative\(/g)).toHaveLength(1);
    expect(configured).not.toContain("super.scene(scene, willConnectTo:");
    expect(configured.indexOf("factory.startReactNative(")).toBeLessThan(
      configured.indexOf("appDelegate.vorteoInitialLaunchOptions = nil"),
    );
    expect(configured).toContain("withModuleName: provider.reactNativeFactoryModuleName");
    expect(configured).toContain("provider.window = window");
    expect(configurePasteInputAppDelegate(configured)).toBe(configured);
  });

  it("captures app launch options without bypassing Expo's subscribers", () => {
    const configured = configurePasteInputAppDelegate(sceneTemplate);
    expect(configured).toContain(
      "var vorteoInitialLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?",
    );
    expect(configured.indexOf("vorteoInitialLaunchOptions = launchOptions")).toBeLessThan(
      configured.indexOf("let factory = ExpoReactNativeFactory"),
    );
    expect(configured).toContain(
      "return super.application(application, didFinishLaunchingWithOptions: launchOptions)",
    );
    expect(configured).toContain("var launchOptions = initial ?? [:]");
  });

  it("retains cold notification payload, URL metadata and all user activity types", () => {
    const configured = configurePasteInputAppDelegate(sceneTemplate);
    for (const key of [
      "URL",
      "SourceApplication",
      "Annotation",
      "UserActivityDictionary",
      "RemoteNotification",
    ]) {
      expect(configured).toContain(`UIApplicationLaunchOptions${key}Key`);
    }
    expect(configured).toContain("response.notification.request.content.userInfo");
    expect(configured).toContain("?? options.userActivities.first");
    expect(configured).toContain("return launchOptions.isEmpty ? nil : launchOptions");
  });

  it("reuses the window and inherits Expo event forwarding on reconnect", () => {
    const configured = configurePasteInputAppDelegate(sceneTemplate);
    expect(configured).toContain("if let existingWindow = provider.window");
    expect(configured).toContain("existingWindow.windowScene = windowScene");
    expect(configured).toContain("existingWindow.makeKeyAndVisible()");
    expect(configured).toContain("self.scene(scene, openURLContexts: options.urlContexts)");
    expect(configured).toContain("self.scene(scene, continue: $0)");
    expect(configured).toContain("self.windowScene(scene, performActionFor: shortcut");
    expect(configured).not.toContain("override func sceneDidBecomeActive");
  });

  it("upgrades the previous paste-only scene and rejects unknown native startup", () => {
    const previous = `
@objc(PaseoSceneDelegate)
class PaseoSceneDelegate: ExpoAppSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    guard let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
      let factory = provider.reactNativeFactory else { return }
    PasteInputModule.setup(factory.rootViewFactory)
  }
}
`;
    expect(configurePasteInputAppDelegate(`${sceneTemplate}\n${previous}`)).toBe(
      configurePasteInputAppDelegate(sceneTemplate),
    );
    expect(() => configurePasteInputAppDelegate("custom startup")).toThrow("SDK57");
    expect(() =>
      configurePasteInputAppDelegate(
        `${sceneTemplate}\nclass PaseoSceneDelegate: CustomDelegate {}`,
      ),
    ).toThrow("unknown");
  });

  it("matches the installed Expo scene forwarding and factory-provider APIs", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const expo = path.dirname(require.resolve("expo/package.json"));
    const scene = fs.readFileSync(
      path.join(expo, "ios/AppDelegates/ExpoAppSceneDelegate.swift"),
      "utf8",
    );
    const provider = fs.readFileSync(
      path.join(expo, "ios/AppDelegates/ExpoReactNativeFactoryProvider.swift"),
      "utf8",
    );
    expect(scene).toContain("open class ExpoAppSceneDelegate");
    expect(scene).toContain("open func scene(_ scene: UIScene, openURLContexts");
    expect(scene).toContain("open func scene(_ scene: UIScene, continue userActivity:");
    expect(scene).toContain("open func windowScene(");
    expect(provider).toContain("var window: UIWindow? { get set }");
    expect(provider).toContain("var reactNativeFactoryModuleName: String { get }");
  });

  it("exposes the Objective-C module to Swift through the bridging header", () => {
    const source = "// Swift bridging header\n";
    const configured = configurePasteInputBridgingHeader(source);

    expect(configured).toContain("#import <react-native-paste-input/PasteInputModule.h>");
    expect(configurePasteInputBridgingHeader(configured)).toBe(configured);
  });
  it("enables the legacy new-architecture flag required by the paste input podspec", () => {
    const source =
      "require File.join(File.dirname(`node --print \"require.resolve('expo/package.json')\"`), 'scripts/autolinking')";
    const configured = configurePasteInputPodfile(source);
    expect(configured).toBe("ENV['RCT_NEW_ARCH_ENABLED'] = '1'\n" + source);
    expect(configurePasteInputPodfile(configured)).toBe(configured);
  });
});

describe("hardware keyboard with Vorteo scene startup", () => {
  it("observes the started window without changing cold notification launch options", () => {
    const {
      configureHardwareKeyboardAppDelegate,
    } = require("../modules/paseo-hardware-keyboard/app.plugin.js");
    const paste = configurePasteInputAppDelegate(sceneTemplate);
    const configured = configureHardwareKeyboardAppDelegate(paste);
    expect(configured.match(/factory.startReactNative\(/g)).toHaveLength(1);
    expect(configured.indexOf("launchOptions: launchOptions")).toBeLessThan(
      configured.indexOf("PaseoHardwareKeyboardWindow.observing(window)"),
    );
    expect(configured).toContain("response.notification.request.content.userInfo");
    expect(configured).toContain("initial: appDelegate.vorteoInitialLaunchOptions");
    expect(configured).toContain("provider.window = observedWindow");
    expect(configured).not.toContain("super.scene(scene, willConnectTo:");
    expect(configureHardwareKeyboardAppDelegate(configured)).toBe(configured);
  });
});
