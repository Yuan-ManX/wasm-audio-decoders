import { WASMAudioDecoderCommon } from "@wasm-audio-decoders/common";

import EmscriptenWASM from "./EmscriptenWasm.js";

export default function OpusDecoder(options = {}) {
  // static properties
  if (!OpusDecoder.errors) {
    // prettier-ignore
    Object.defineProperties(OpusDecoder, {
      errors: {
        value: new Map([
          [-1, "OPUS_BAD_ARG: One or more invalid/out of range arguments"],
          [-2, "OPUS_BUFFER_TOO_SMALL: Not enough bytes allocated in the buffer"],
          [-3, "OPUS_INTERNAL_ERROR: An internal error was detected"],
          [-4, "OPUS_INVALID_PACKET: The compressed data passed is corrupted"],
          [-5, "OPUS_UNIMPLEMENTED: Invalid/unsupported request number"],
          [-6, "OPUS_INVALID_STATE: An encoder or decoder structure is invalid or already freed"],
          [-7, "OPUS_ALLOC_FAIL: Memory allocation has failed"],
        ]),
      },
    });
  }

  // injects dependencies when running as a web worker
  // async
  this._init = () => {
    return new this._WASMAudioDecoderCommon(this)
      .instantiate()
      .then((common) => {
        this._common = common;

        const mapping = this._common.allocateTypedArray(
          this._channels,
          Uint8Array
        );

        mapping.buf.set(this._channelMappingTable);

        this._decoder = this._common.wasm._opus_frame_decoder_create(
          this._channels,
          this._streamCount,
          this._coupledStreamCount,
          mapping.ptr,
          this._preSkip,
          this._forceStereo
        );
      });
  };

  Object.defineProperty(this, "ready", {
    enumerable: true,
    get: () => this._ready,
  });

  // async
  this.reset = () => {
    this.free();
    return this._init();
  };

  this.free = () => {
    this._common.wasm._opus_frame_decoder_destroy(this._decoder);

    this._common.free();
  };

  this._decode = (opusFrame) => {
    if (!(opusFrame instanceof Uint8Array))
      throw Error(
        "Data to decode must be Uint8Array. Instead got " + typeof opusFrame
      );

    this._input.buf.set(opusFrame);

    let samplesDecoded =
      this._common.wasm._opus_frame_decode_float_deinterleaved(
        this._decoder,
        this._input.ptr,
        opusFrame.length,
        this._output.ptr
      );

    let error;

    if (samplesDecoded < 0) {
      error =
        "libopus " +
        samplesDecoded +
        " " +
        (OpusDecoder.errors.get(samplesDecoded) || "Unknown Error");

      console.error(error);
      samplesDecoded = 0;
    }

    return {
      outputBuffer: this._common.getOutputChannels(
        this._output.buf,
        this._outputChannels,
        samplesDecoded
      ),
      samplesDecoded: samplesDecoded,
      error: error,
    };
  };

  this._addError = (
    errors,
    message,
    frameLength,
    relativeFrameNumber,
    relativeInputBytes,
    relativeOutputSamples
  ) => {
    errors.push({
      message: message,
      frameLength: frameLength,
      relativeFrameNumber: relativeFrameNumber,
      relativeInputBytes: relativeInputBytes,
      relativeOutputSamples: relativeOutputSamples,
      totalFrameNumber: this._totalFrameNumber,
      totalInputBytes: this._totalInputBytes,
      totalOutputSamples: this._totalOutputSamples,
    });
  };

  this.decodeFrame = (opusFrame) => {
    let errors = [];

    const decoded = this._decode(opusFrame);

    if (decoded.error)
      this._addError(errors, decoded.error, opusFrame.length, 0, 0, 0);

    this._totalFrameNumber++;
    this._totalInputBytes += opusFrame.length;
    this._totalOutputSamples += decoded.samplesDecoded;

    return this._WASMAudioDecoderCommon.getDecodedAudioMultiChannel(
      errors,
      [decoded.outputBuffer],
      this._outputChannels,
      decoded.samplesDecoded,
      48000
    );
  };

  this.decodeFrames = (opusFrames) => {
    let outputBuffers = [],
      errors = [],
      frameNumber = 0,
      inputBytes = 0,
      outputSamples = 0,
      i = 0;

    while (i < opusFrames.length) {
      const opusFrame = opusFrames[i++];
      const decoded = this._decode(opusFrame);

      if (decoded.error)
        this._addError(
          errors,
          decoded.error,
          opusFrame.length,
          frameNumber,
          inputBytes,
          outputSamples
        );

      outputBuffers.push(decoded.outputBuffer);

      frameNumber++;
      inputBytes += opusFrame.length;
      outputSamples += decoded.samplesDecoded;
      this._totalFrameNumber++;
      this._totalInputBytes += opusFrame.length;
      this._totalOutputSamples += decoded.samplesDecoded;
    }

    return this._WASMAudioDecoderCommon.getDecodedAudioMultiChannel(
      errors,
      outputBuffers,
      this._outputChannels,
      outputSamples,
      48000
    );
  };

  // injects dependencies when running as a web worker
  this._isWebWorker = OpusDecoder.isWebWorker;
  this._WASMAudioDecoderCommon =
    OpusDecoder.WASMAudioDecoderCommon || WASMAudioDecoderCommon;
  this._EmscriptenWASM = OpusDecoder.EmscriptenWASM || EmscriptenWASM;
  this._module = OpusDecoder.module;

  const MAX_FORCE_STEREO_CHANNELS = 8;
  const isNumber = (param) => typeof param === "number";

  const channels = options.channels;
  const streamCount = options.streamCount;
  const coupledStreamCount = options.coupledStreamCount;
  const channelMappingTable = options.channelMappingTable;
  const preSkip = options.preSkip;
  const forceStereo = options.forceStereo ? 1 : 0;

  // channel mapping family >= 1
  if (
    channels > 2 &&
    (!isNumber(streamCount) ||
      !isNumber(coupledStreamCount) ||
      !Array.isArray(channelMappingTable))
  ) {
    throw new Error("Invalid Opus Decoder Options for multichannel decoding.");
  }

  // channel mapping family 0
  this._channels = isNumber(channels) ? channels : 2;
  this._streamCount = isNumber(streamCount) ? streamCount : 1;
  this._coupledStreamCount = isNumber(coupledStreamCount)
    ? coupledStreamCount
    : this._channels - 1;
  this._channelMappingTable =
    channelMappingTable || (this._channels === 2 ? [0, 1] : [0]);
  this._preSkip = preSkip || 0;

  this._forceStereo =
    channels <= MAX_FORCE_STEREO_CHANNELS && channels != 2 ? forceStereo : 0;

  this._inputSize = 32000 * 0.12 * this._channels; // 256kbs per channel
  this._outputChannelSize = 120 * 48;
  this._outputChannels = this._forceStereo ? 2 : this._channels;

  this._ready = this._init();

  return this;
}
