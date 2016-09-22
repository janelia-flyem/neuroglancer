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
import {MeshSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/precomputed/base';
import {FragmentChunk, ManifestChunk, ParameterizedMeshSource, decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices} from 'neuroglancer/mesh/backend';
import {ParameterizedVolumeChunkSource, VolumeChunk} from 'neuroglancer/sliceview/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {Endianness} from 'neuroglancer/util/endian';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';

const chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(VolumeChunkEncoding.COMPRESSED_SEGMENTATION, decodeCompressedSegmentationChunk);

@registerChunkSource(VolumeChunkSourceParameters)
class VolumeChunkSource extends ParameterizedVolumeChunkSource<VolumeChunkSourceParameters> {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  download(chunk: VolumeChunk) {
    let {parameters} = this;
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let chunkDataSize = chunk.chunkDataSize!;
      path =
          `${parameters.path}/${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
    }
    handleChunkDownloadPromise(
        chunk, sendHttpRequest(openShardedHttpRequest(parameters.baseUrls, path), 'arraybuffer'),
        this.chunkDecoder);
  }
};

export function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, 'fragments');
}

export function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  decodeTriangleVertexPositionsAndIndices(
      chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/4, numVertices);
}

@registerChunkSource(MeshSourceParameters)
class MeshSource extends ParameterizedMeshSource<MeshSourceParameters> {
  download(chunk: ManifestChunk) {
    let {parameters} = this;
    let requestPath = `${parameters.path}/${chunk.objectId}:${parameters.lod}`;
    handleChunkDownloadPromise(
        chunk, sendHttpRequest(openShardedHttpRequest(parameters.baseUrls, requestPath), 'json'),
        decodeManifestChunk);
  }

  downloadFragment(chunk: FragmentChunk) {
    let {parameters} = this;
    let requestPath = `${parameters.path}/${chunk.fragmentId}`;
    handleChunkDownloadPromise(
        chunk,
        sendHttpRequest(openShardedHttpRequest(parameters.baseUrls, requestPath), 'arraybuffer'),
        decodeFragmentChunk);
  }
};
