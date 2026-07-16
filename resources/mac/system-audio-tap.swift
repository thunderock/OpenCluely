// system-audio-tap.swift — macOS system/loopback audio capture for OpenCluely (STT-04).
//
// Ported from OpenWhispr's MIT-licensed `resources/macos-audio-tap.swift` (see
// .planning/research/OPENWHISPR-NOTES.md §2.1) with two OpenCluely deltas:
//   1. Output is 16 kHz mono 16-bit PCM raw on stdout (OpenWhispr defaults to
//      24 kHz) so the stream feeds SpeechService.handleSystemAudioChunk →
//      _ingestWhisperAudio / _createWavBuffer UNCHANGED.
//   2. Deployment target is macOS 14.4 (not 14.2): the 2026 Core Audio Taps
//      writeups say a target >= 14.4 keeps the capture in the correct
//      NSAudioCaptureUsageDescription TCC category (04-RESEARCH Flag 3).
//
// Mechanism (Core Audio Process Tap API, macOS 14.2+; NOT ScreenCaptureKit, NOT
// a virtual device, NOT AVAudioEngine):
//   - A CATapDescription that taps the WHOLE-SYSTEM mix (a global tap that
//     excludes NO processes — the `processes = []` + exclusive shape; note the
//     isExclusive direction is a documented foot-gun that inverts include/exclude).
//   - Wrapped in a PRIVATE aggregate device (kAudioAggregateDeviceTapListKey,
//     isPrivate = true) whose MAIN sub-device is a REAL output device — a
//     tap-only aggregate with no real sub-device silently produces SILENCE.
//   - Driven by an AudioDeviceIOProcID block (AVAudioEngine silently ignores
//     aggregate-device retargeting), converting the tap's native float format to
//     16 kHz mono Int16 via AVAudioConverter.
//
// Contract:
//   - stdout: raw 16-bit little-endian mono PCM at the target sample rate.
//   - stderr: line-delimited JSON status — {"type":"start"|"stop"|"error", ...}.
//             The Node manager treats the first {"type":"start"} as
//             "permission granted + tap live".
//   - kAudioHardwareIllegalOperationError → {"type":"error","code":"permission_denied"}.
//   - macOS < 14.4 → {"type":"error","code":"unsupported_os"} then exit 0.
//
// Build: scripts/build-macos-audio-tap.js (xcrun swiftc, target 14.4, lipo).

import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

// MARK: - IO helpers (line-JSON on stderr, raw PCM on stdout)

/// Emit one line-delimited JSON status object on stderr. Best-effort; never throws.
func emitStatus(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardError.write(Data(line.utf8))
}

/// Write raw PCM bytes to stdout. The Node side pipes this straight into the
/// system VadSegmenter, so no framing is added here.
let stdoutHandle = FileHandle.standardOutput
func writePCM(_ data: Data) {
    guard !data.isEmpty else { return }
    stdoutHandle.write(data)
}

// MARK: - Core Audio property helpers

/// The system default output device — used as the aggregate's REAL main
/// sub-device (a tap-only aggregate produces silence, a documented gotcha).
func defaultOutputDeviceID() -> AudioObjectID {
    var deviceID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
    return deviceID
}

/// The CoreAudio UID string of a device (needed to reference it inside the
/// aggregate-device description dictionary).
func deviceUID(_ deviceID: AudioObjectID) -> String? {
    var uid: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let err = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uid)
    return err == noErr ? (uid as String) : nil
}

// MARK: - The tap

@available(macOS 14.4, *)
final class SystemAudioTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var deviceProcID: AudioDeviceIOProcID?
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let outputFormat: AVAudioFormat
    private let targetSampleRate: Double

    init(sampleRate: Double) {
        self.targetSampleRate = sampleRate
        // 16 kHz mono 16-bit interleaved — exactly what _createWavBuffer frames.
        self.outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: true
        )!
    }

    struct TapError: Error { let message: String }

    func start() throws {
        // 1. Whole-system mix: a GLOBAL tap that excludes NO processes. This is
        //    the `processes = []` + exclusive shape; the convenience initializer
        //    sets the isExclusive direction correctly (mis-setting it by hand
        //    inverts include/exclude semantics).
        let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        tapDescription.isPrivate = true
        tapDescription.muteBehavior = .unmuted // keep the call audible while tapping

        // 2. Create the process tap. Permission failure surfaces here.
        var err = AudioHardwareCreateProcessTap(tapDescription, &tapID)
        if err == kAudioHardwareIllegalOperationError {
            emitStatus(["type": "error", "code": "permission_denied",
                        "message": "system audio capture not permitted"])
            throw TapError(message: "permission_denied")
        }
        guard err == noErr, tapID != AudioObjectID(kAudioObjectUnknown) else {
            emitStatus(["type": "error", "code": "tap_create_failed", "osstatus": Int(err)])
            throw TapError(message: "AudioHardwareCreateProcessTap failed: \(err)")
        }

        // 3. A REAL output device is required as the aggregate's main sub-device.
        let outputDevice = defaultOutputDeviceID()
        guard outputDevice != AudioObjectID(kAudioObjectUnknown),
              let outputUID = deviceUID(outputDevice) else {
            emitStatus(["type": "error", "code": "no_output_device",
                        "message": "no default output device to anchor the tap"])
            throw TapError(message: "no default output device")
        }

        // 4. Private aggregate device wrapping the tap. Main sub-device = the real
        //    output device; tap referenced by its UUID in the tap list.
        let aggregateUID = UUID().uuidString
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "OpenCluely System Tap",
            kAudioAggregateDeviceUIDKey: aggregateUID,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [
                [kAudioSubDeviceUIDKey: outputUID],
            ],
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapDriftCompensationKey: true,
                    kAudioSubTapUIDKey: tapDescription.uuid.uuidString,
                ],
            ],
        ]
        err = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateID)
        guard err == noErr, aggregateID != AudioObjectID(kAudioObjectUnknown) else {
            emitStatus(["type": "error", "code": "aggregate_create_failed", "osstatus": Int(err)])
            throw TapError(message: "AudioHardwareCreateAggregateDevice failed: \(err)")
        }

        // 5. Read the tap's native stream format and build the converter to 16 kHz
        //    mono Int16.
        var tapASBD = AudioStreamBasicDescription()
        var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var formatAddress = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        err = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &asbdSize, &tapASBD)
        guard err == noErr, let inFormat = AVAudioFormat(streamDescription: &tapASBD) else {
            emitStatus(["type": "error", "code": "tap_format_failed", "osstatus": Int(err)])
            throw TapError(message: "could not read tap format: \(err)")
        }
        self.inputFormat = inFormat
        guard let conv = AVAudioConverter(from: inFormat, to: outputFormat) else {
            emitStatus(["type": "error", "code": "converter_failed",
                        "message": "could not build AVAudioConverter"])
            throw TapError(message: "AVAudioConverter init failed")
        }
        self.converter = conv

        // 6. Drive the aggregate with an IOProc block (NOT AVAudioEngine).
        err = AudioDeviceCreateIOProcIDWithBlock(&deviceProcID, aggregateID, nil) {
            [weak self] _, inInputData, _, _, _ in
            self?.handleInput(inInputData)
        }
        guard err == noErr, deviceProcID != nil else {
            emitStatus(["type": "error", "code": "ioproc_failed", "osstatus": Int(err)])
            throw TapError(message: "AudioDeviceCreateIOProcIDWithBlock failed: \(err)")
        }

        // 7. Start the device. Once this returns noErr the tap is live.
        err = AudioDeviceStart(aggregateID, deviceProcID)
        guard err == noErr else {
            emitStatus(["type": "error", "code": "device_start_failed", "osstatus": Int(err)])
            throw TapError(message: "AudioDeviceStart failed: \(err)")
        }

        emitStatus([
            "type": "start",
            "sampleRate": targetSampleRate,
            "channels": 1,
            "format": "pcm_s16le",
        ])
    }

    /// Convert one IOProc buffer of tap audio to 16 kHz mono Int16 and write it to
    /// stdout. Runs on the CoreAudio IO thread — keep it allocation-light and
    /// never throw out of here.
    private func handleInput(_ inInputData: UnsafePointer<AudioBufferList>) {
        guard let converter = converter, let inFormat = inputFormat else { return }

        let inBufferList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
        guard let firstBuffer = inBufferList.first, firstBuffer.mDataByteSize > 0 else { return }

        let bytesPerFrame = max(inFormat.streamDescription.pointee.mBytesPerFrame, 1)
        let inFrames = firstBuffer.mDataByteSize / bytesPerFrame
        guard inFrames > 0,
              let inPCM = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: inFrames) else { return }
        inPCM.frameLength = inFrames

        // Copy the IOProc buffers into the input AVAudioPCMBuffer.
        if let dstList = UnsafeMutableAudioBufferListPointer(inPCM.mutableAudioBufferList) as UnsafeMutableAudioBufferListPointer?,
           dstList.count == inBufferList.count {
            for i in 0..<inBufferList.count {
                if let src = inBufferList[i].mData, let dst = dstList[i].mData {
                    let n = Int(min(inBufferList[i].mDataByteSize, dstList[i].mDataByteSize))
                    memcpy(dst, src, n)
                }
            }
        }

        // Output capacity scaled by the sample-rate ratio (+ headroom).
        let ratio = outputFormat.sampleRate / inFormat.sampleRate
        let outCapacity = AVAudioFrameCount(Double(inFrames) * ratio + 1024)
        guard let outPCM = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outCapacity) else { return }

        var consumed = false
        var convError: NSError?
        let status = converter.convert(to: outPCM, error: &convError) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return inPCM
        }
        guard status != .error, convError == nil, outPCM.frameLength > 0,
              let channelData = outPCM.int16ChannelData else { return }

        let byteCount = Int(outPCM.frameLength) * MemoryLayout<Int16>.size
        writePCM(Data(bytes: channelData[0], count: byteCount))
    }

    func stop() {
        if let proc = deviceProcID {
            AudioDeviceStop(aggregateID, proc)
            AudioDeviceDestroyIOProcID(aggregateID, proc)
            deviceProcID = nil
        }
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        emitStatus(["type": "stop"])
    }
}

// MARK: - Entry point

/// Parse `--sample-rate <hz>` (default 16000). Keeps the helper self-describing
/// even though OpenCluely always drives it at 16 kHz.
func parseSampleRate() -> Double {
    let args = CommandLine.arguments
    if let idx = args.firstIndex(of: "--sample-rate"), idx + 1 < args.count,
       let hz = Double(args[idx + 1]), hz > 0 {
        return hz
    }
    return 16000
}

guard #available(macOS 14.4, *) else {
    // Below the floor → degrade-to-mic on the Node side.
    emitStatus(["type": "error", "code": "unsupported_os",
                "message": "Core Audio Process Tap requires macOS 14.4+"])
    exit(0)
}

let tap = SystemAudioTap(sampleRate: parseSampleRate())

// Clean teardown on SIGTERM/SIGINT (the Node manager SIGTERMs the child on stop).
let signalSource = { (sig: Int32) -> DispatchSourceSignal in
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler {
        tap.stop()
        exit(0)
    }
    src.resume()
    return src
}
let sigterm = signalSource(SIGTERM)
let sigint = signalSource(SIGINT)
_ = (sigterm, sigint) // keep the sources alive

do {
    try tap.start()
} catch {
    // start() already emitted a structured error; exit non-zero so the manager
    // sees the failure. permission_denied/unsupported_os both degrade to mic.
    exit(1)
}

// Keep the process alive to service the IOProc until signalled.
RunLoop.main.run()
