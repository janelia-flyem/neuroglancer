/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {handleChunkDownloadPromise, registerChunkSource} from 'neuroglancer/chunk_manager/backend';
import {SkeletonSourceParameters, TileChunkSourceParameters, TileEncoding, VolumeChunkSourceParameters, StackParameters} from 'neuroglancer/datasource/dvid/base';
import {ParameterizedSkeletonSource, SkeletonChunk} from 'neuroglancer/skeleton/backend';
import {ParameterizedVolumeChunkSource, VolumeChunk} from 'neuroglancer/sliceview/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {VolumeType} from 'neuroglancer/sliceview/base';
import {decodeSwcSkeletonChunk} from 'neuroglancer/sliceview/decode_swc_skeleton';
import {Endianness} from 'neuroglancer/util/endian';
import {VolumeType} from 'neuroglancer/sliceview/base';
import {vec3, vec4} from 'neuroglancer/util/geom';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {RPC} from 'neuroglancer/worker_rpc';

import {ParameterizedStackChunkSource} from 'neuroglancer/stack/backend';

const TILE_CHUNK_DECODERS = new Map<TileEncoding, ChunkDecoder>([
  [TileEncoding.JPEG, decodeJpegChunk],
]);

@registerChunkSource(VolumeChunkSourceParameters)
class VolumeChunkSource extends ParameterizedVolumeChunkSource<VolumeChunkSourceParameters> {

  compressedSegmentationBlockSize: vec3|undefined;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);

    this.parameters = options['parameters'];
    if (this.parameters.volumeType === VolumeType.SEGMENTATION) {
      this.compressedSegmentationBlockSize = vec3.fromValues(8, 8, 8);
    }
  }

  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let params = this.parameters;
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let chunkDataSize = chunk.chunkDataSize!;

      // if the volume is an image, get a jpeg
      path = this.getPath(chunkPosition, chunkDataSize, params);
    }

    const decoder = this.getDecoder(params);
    return sendHttpRequest(
               openShardedHttpRequest(params.baseUrls, path), 'arraybuffer', cancellationToken)
        .then(response => decoder(chunk, response));
  }

  getPath(chunkPosition: Float32Array, chunkDataSize: Float32Array, params: any) {
    if (params.volumeType === VolumeType.IMAGE) {
      return `/api/node/${params['nodeKey']}/${params['dataInstanceKey']}/raw/0_1_2/${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}/jpeg`;
    } else {
      // volumeType is SEGMENTATION
      let dataInstanceKey = params['dataInstanceKey'];
      return `/api/node/${params['nodeKey']}/${dataInstanceKey}/raw/0_1_2/${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}?compression=googlegzip`;
    }
  }

  getDecoder(params: any) {
    if (params.volumeType === VolumeType.IMAGE) {
      return decodeJpegChunk;
    } else {
      // volumeType is SEGMENTATION
      return decodeCompressedSegmentationChunk;
    }

  }
}

@registerChunkSource(TileChunkSourceParameters)
class TileChunkSource extends ParameterizedVolumeChunkSource<TileChunkSourceParameters> {
  chunkDecoder = TILE_CHUNK_DECODERS.get(this.parameters['encoding'])!;

  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let params = this.parameters;
    let {chunkGridPosition} = chunk;

    // Needed by decoder.
    chunk.chunkDataSize = this.spec.chunkDataSize;
    let path = `/api/node/${params['nodeKey']}/${params['dataInstanceKey']}/tile/` +
        `${params['dims']}/${params['level']}/` +
        `${chunkGridPosition[0]}_${chunkGridPosition[1]}_${chunkGridPosition[2]}`;
    return sendHttpRequest(
               openShardedHttpRequest(params.baseUrls, path), 'arraybuffer', cancellationToken)
        .then(response => this.chunkDecoder(chunk, response));
  }

};

@registerChunkSource(SkeletonSourceParameters)
export class SkeletonSource extends ParameterizedSkeletonSource<SkeletonSourceParameters> {
  download(chunk: SkeletonChunk) {
    const params = this.parameters;
    // example:
    // http://emdata1:7000/api/node/d5053e99753848e599a641925aa2d38f/bodies1104_skeletons/key/102160_swc
    const path =
        `/api/node/${params['nodeKey']}/${params['dataInstanceKey']}/key/${chunk.objectId}_swc`;
    handleChunkDownloadPromise(
        chunk, sendHttpRequest(openShardedHttpRequest(params.baseUrls, path), 'text'),
        decodeSkeletonChunk);
  }
};

function decodeSkeletonChunk(chunk: SkeletonChunk, result: string) {
  decodeSwcSkeletonChunk(chunk, result, Endianness.LITTLE);
}

@registerChunkSource(StackParameters)
class StackChunkSource extends ParameterizedStackChunkSource<StackParameters> {

  getColor(position: string /* vec3Key for chunk position */){
    let color = this.parameters.colors.get(position);
    if(!color){
      color = new Float32Array([0,0,0,0]);
    }
    return color;
  }

};

