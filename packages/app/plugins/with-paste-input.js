const fs = require("node:fs");
const path = require("node:path");
const {
  IOSConfig,
  withAppDelegate,
  withDangerousMod,
  withInfoPlist,
  withPodfile,
} = require("expo/config-plugins");

const BRIDGING_HEADER_IMPORT = "#import <react-native-paste-input/PasteInputModule.h>";
const LEGACY_SCENE_DELEGATE = `
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

const SCENE_DELEGATE = `
// Expo57 has no launch-options override. Customize only connection; inherit its event forwarding.
@objc(PaseoSceneDelegate)
class PaseoSceneDelegate: ExpoAppSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let provider = appDelegate as? ExpoReactNativeFactoryProvider,
      let factory = provider.reactNativeFactory else {
      preconditionFailure("Missing Expo React Native factory for scene startup")
    }
    // Reconnection keeps the existing window and React runtime, including unsaved drafts.
    if let existingWindow = provider.window {
      window = existingWindow
      existingWindow.windowScene = windowScene
      existingWindow.makeKeyAndVisible()
      PasteInputModule.setup(factory.rootViewFactory)
      forwardConnectionOptions(windowScene, options: connectionOptions)
      return
    }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    provider.window = window
    let launchOptions = Self.vorteoLaunchOptions(
      initial: appDelegate.vorteoInitialLaunchOptions,
      options: connectionOptions
    )
    factory.startReactNative(
      withModuleName: provider.reactNativeFactoryModuleName,
      in: window,
      launchOptions: launchOptions
    )
    appDelegate.vorteoInitialLaunchOptions = nil
    PasteInputModule.setup(factory.rootViewFactory)
    forwardConnectionOptions(windowScene, options: connectionOptions)
  }

  private static func vorteoLaunchOptions(
    initial: [UIApplication.LaunchOptionsKey: Any]?,
    options: UIScene.ConnectionOptions
  ) -> [UIApplication.LaunchOptionsKey: Any]? {
    var launchOptions = initial ?? [:]
    // Raw keys match Expo57 and avoid the deprecated UIKit launch-option accessors.
    if let context = options.urlContexts.first {
      launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")] = context.url
      launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsSourceApplicationKey")] = context.options.sourceApplication
      launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsAnnotationKey")] = context.options.annotation
    }
    let activity = options.userActivities.first { $0.activityType == NSUserActivityTypeBrowsingWeb }
      ?? options.userActivities.first
    if let activity {
      launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity
      ]
    }
    if let response = options.notificationResponse {
      launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsRemoteNotificationKey")] = response.notification.request.content.userInfo
    }
    return launchOptions.isEmpty ? nil : launchOptions
  }

  private func forwardConnectionOptions(_ scene: UIWindowScene, options: UIScene.ConnectionOptions) {
    // Use Expo's inherited SceneEventForwarder, including its Linking deduplication.
    self.scene(scene, openURLContexts: options.urlContexts)
    options.userActivities.forEach { self.scene(scene, continue: $0) }
#if os(iOS)
    if let shortcut = options.shortcutItem {
      self.windowScene(scene, performActionFor: shortcut, completionHandler: { _ in })
    }
#endif
  }
}
`;

function configurePasteInputAppDelegate(contents) {
  const capture = "    vorteoInitialLaunchOptions = launchOptions";
  const storedOptions = "  var vorteoInitialLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?";
  if (
    contents.includes(SCENE_DELEGATE.trim()) &&
    contents.includes(capture) &&
    contents.includes(storedOptions)
  )
    return contents;
  // A non-clean prebuild may still contain the previously generated paste-only scene.
  if (contents.includes("class PaseoSceneDelegate:")) {
    if (!contents.includes(LEGACY_SCENE_DELEGATE.trim())) {
      throw new Error("Refusing to replace an unknown PaseoSceneDelegate");
    }
    contents = contents.replace(LEGACY_SCENE_DELEGATE.trim(), "");
  }
  const window = /^  var window: UIWindow\?\s*$/m;
  const startup =
    /(didFinishLaunchingWithOptions launchOptions: \[UIApplication\.LaunchOptionsKey: Any\]\? = nil\s*\) -> Bool \{)/;
  if (
    !contents.includes("ExpoReactNativeFactoryProvider") ||
    !window.test(contents) ||
    !startup.test(contents) ||
    contents.includes("factory.startReactNative(")
  ) {
    throw new Error("Paste input requires the Expo SDK57 scene AppDelegate template");
  }
  const configured = contents
    .replace(window, (line) => `${line.trimEnd()}\n${storedOptions}`)
    .replace(startup, `$1\n${capture}`);
  return `${configured.trimEnd()}\n${SCENE_DELEGATE}`;
}

function configurePasteInputBridgingHeader(contents) {
  if (contents.includes(BRIDGING_HEADER_IMPORT)) {
    return contents;
  }
  return `${contents.trimEnd()}\n${BRIDGING_HEADER_IMPORT}\n`;
}

function withPasteInput(config) {
  const withDelegate = withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== "swift") {
      throw new Error("Paste input setup requires a Swift AppDelegate");
    }
    modConfig.modResults.contents = configurePasteInputAppDelegate(modConfig.modResults.contents);
    return modConfig;
  });
  const withScene = withInfoPlist(withDelegate, (modConfig) => {
    const scenes =
      modConfig.modResults.UIApplicationSceneManifest?.UISceneConfigurations
        ?.UIWindowSceneSessionRoleApplication;
    if (!scenes || scenes.length !== 1) {
      throw new Error("Paste input requires Expo's single scene configuration");
    }
    scenes[0].UISceneDelegateClassName = "PaseoSceneDelegate";
    return modConfig;
  });
  const withPods = withPodfile(withScene, (modConfig) => {
    // Paste input checks this legacy flag even though RN 0.86 only supports Fabric.
    modConfig.modResults.contents = configurePasteInputPodfile(modConfig.modResults.contents);
    return modConfig;
  });
  return withPasteInputBridgingHeader(withPods);
}

function withPasteInputBridgingHeader(config) {
  return withDangerousMod(config, [
    "ios",
    async (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      const sourceRoot = IOSConfig.Paths.getSourceRoot(projectRoot);
      const projectName = IOSConfig.XcodeUtils.getProjectName(projectRoot);
      const headerPath = path.join(sourceRoot, `${projectName}-Bridging-Header.h`);
      const contents = fs.readFileSync(headerPath, "utf8");
      fs.writeFileSync(headerPath, configurePasteInputBridgingHeader(contents));
      return modConfig;
    },
  ]);
}

module.exports = withPasteInput;
module.exports.configurePasteInputAppDelegate = configurePasteInputAppDelegate;
module.exports.configurePasteInputBridgingHeader = configurePasteInputBridgingHeader;

function configurePasteInputPodfile(contents) {
  const flag = "ENV['RCT_NEW_ARCH_ENABLED'] = '1'";
  return contents.includes(flag) ? contents : `${flag}\n${contents}`;
}
module.exports.configurePasteInputPodfile = configurePasteInputPodfile;
