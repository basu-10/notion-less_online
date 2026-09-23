#!/usr/bin/env bash
# Build the NotionLess companion APK and optionally install it.
# Usage:
#   ./build_apk.sh              # build debug APK only
#   ./build_apk.sh --install    # build + install to attached device
#   ./build_apk.sh --release    # build release APK instead
#   ./build_apk.sh --release --install
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_TYPE="debug"
DO_INSTALL=0

for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=1 ;;
    --release) BUILD_TYPE="release" ;;
    --debug) BUILD_TYPE="debug" ;;
    -h|--help)
      echo "Usage: $0 [--debug|--release] [--install]"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

GRADLE_VERSION="8.7"
GRADLE_DIST_DIR="${HOME}/.gradle-dist"
GRADLE_HOME="${GRADLE_DIST_DIR}/gradle-${GRADLE_VERSION}"
GRADLE_BIN="${GRADLE_HOME}/bin/gradle"

echo "==> Checking Java (need 17+)..."
java -version 2>&1
JAVA_MAJOR="$(java -version 2>&1 | head -1 | grep -oE '[0-9]+' | head -1)"
if [ "${JAVA_MAJOR}" -lt 17 ]; then
  echo "ERROR: Java 17+ required, found ${JAVA_MAJOR}" >&2
  exit 1
fi

echo "==> Checking Android SDK..."
if [ -z "${ANDROID_HOME:-}" ]; then
  for cand in /tools/android-sdk "$HOME/Android/Sdk" /opt/android-sdk /usr/lib/android-sdk; do
    if [ -d "$cand/platform-tools" ]; then
      export ANDROID_HOME="$cand"
      break
    fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "${ANDROID_HOME}" ]; then
  echo "ERROR: ANDROID_HOME not set and no SDK found." >&2
  exit 1
fi
echo "    ANDROID_HOME=${ANDROID_HOME}"
"${ANDROID_HOME}/platform-tools/adb" version 2>&1 | head -3
# local.properties keeps AGP happy even when env differs
echo "sdk.dir=${ANDROID_HOME}" > "${SCRIPT_DIR}/local.properties"

echo "==> Getting Gradle ${GRADLE_VERSION}..."
if [ ! -x "${GRADLE_BIN}" ]; then
  mkdir -p "${GRADLE_DIST_DIR}"
  TMP_ZIP="/tmp/gradle-${GRADLE_VERSION}-bin.zip"
  if [ ! -f "${TMP_ZIP}" ]; then
    URL="https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip"
    echo "    Downloading ${URL} ..."
    if command -v curl >/dev/null; then
      curl -fSL -o "${TMP_ZIP}" "${URL}"
    else
      wget -O "${TMP_ZIP}" "${URL}"
    fi
  fi
  echo "    Unpacking to ${GRADLE_DIST_DIR} ..."
  rm -rf "${GRADLE_HOME}"
  unzip -q "${TMP_ZIP}" -d "${GRADLE_DIST_DIR}"
fi
"${GRADLE_BIN}" --version | head -12

echo "==> Building ${BUILD_TYPE} APK (this downloads deps on first run, may take a few minutes)..."
cd "${SCRIPT_DIR}"
if [ "${BUILD_TYPE}" = "release" ]; then
  "${GRADLE_BIN}" assembleRelease --console=plain
  APK="app/build/outputs/apk/release/app-release.apk"
else
  "${GRADLE_BIN}" assembleDebug --console=plain
  APK="app/build/outputs/apk/debug/app-debug.apk"
fi

echo "==> Verifying APK..."
if [ ! -f "${APK}" ]; then
  echo "ERROR: expected APK not found at ${APK}" >&2
  find app/build/outputs -name '*.apk' 2>/dev/null || true
  exit 1
fi
ls -lh "${APK}"
echo "SUCCESS: APK created at ${SCRIPT_DIR}/${APK}"

if [ "${DO_INSTALL}" = "1" ]; then
  echo "==> Devices:"
  "${ANDROID_HOME}/platform-tools/adb" devices -l
  echo "==> Installing (reinstall, keep data)..."
  "${ANDROID_HOME}/platform-tools/adb" install -r "${APK}"
  echo "==> Launching app..."
  "${ANDROID_HOME}/platform-tools/adb" shell monkey -p com.notionless.app -c android.intent.category.LAUNCHER 1 || true
  echo "DONE: installed com.notionless.app"
fi
