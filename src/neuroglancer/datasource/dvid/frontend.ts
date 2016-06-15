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

/**
 * @file
 * Support for DVID (https://github.com/janelia-flyem/dvid) servers.
 */

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {VolumeChunkSourceParameters, volumeSourceToString, TileChunkSourceParameters, tileSourceToString, TileEncoding} from 'neuroglancer/datasource/dvid/base';
import {registerDataSourceFactory, CompletionResult} from 'neuroglancer/datasource/factory';
import {DataType, VolumeType, VolumeChunkSpecification} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {VolumeChunkSource as GenericVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {vec3, Vec3} from 'neuroglancer/util/geom';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {parseFixedLengthArray, parseIntVec, stableStringify, verifyObject, verifyObjectProperty, verifyInt, verifyPositiveInt, verifyString, parseArray, verifyMapKey, verifyFinitePositiveFloat, verifyObjectAsMap} from 'neuroglancer/util/json';
import {CancellablePromise} from 'neuroglancer/util/promise';

let serverDataTypes = new Map<string, DataType>();
serverDataTypes.set('uint8', DataType.UINT8);
serverDataTypes.set('uint32', DataType.UINT32);
serverDataTypes.set('uint64', DataType.UINT64);

export class DataInstanceBaseInfo {
  get typeName(): string { return this.obj['TypeName']; }

  constructor (public obj: any) {
    verifyObject(obj);
    verifyObjectProperty(obj, 'TypeName', verifyString);
  }
};

export class DataInstanceInfo {
  constructor(public obj: any, public name: string, public base: DataInstanceBaseInfo) {}
};

export class VolumeChunkSource extends GenericVolumeChunkSource {
  constructor(
    chunkManager: ChunkManager, spec: VolumeChunkSpecification, public parameters: VolumeChunkSourceParameters) {
    super(chunkManager, spec);
    this.initializeCounterpart(chunkManager.rpc, {
      'type': 'dvid/VolumeChunkSource',
      'parameters': parameters,
    });
  }
  toString () {
    return volumeSourceToString(this.parameters);
  }
};

export class VolumeDataInstanceInfo extends DataInstanceInfo {
  dataType: DataType;
  lowerVoxelBound: Vec3;
  upperVoxelBound: Vec3;
  voxelSize: Vec3;
  numChannels: number;
  numLevels: number;

  constructor(obj: any, name: string, base: DataInstanceBaseInfo, public volumeType: VolumeType, keys: Array<string>) {
    super(obj, name, base);
    let extended = verifyObjectProperty(obj, 'Extended', verifyObject);
    let extendedValues = verifyObjectProperty(extended, 'Values', x => parseArray(x, verifyObject));
    if (extendedValues.length < 1) {
      throw new Error(
          'Expected Extended.Values property to have length >= 1, but received: ${JSON.stringify(extendedValues)}.');
    }
    this.numLevels = 1;

    let keyset = new Set<string>(keys);
        while (true) {
        if (keyset.has(name + "_" + this.numLevels.toString())) {
            this.numLevels += 1;    
            } else {
            break;
            }
    }

    this.dataType =
        verifyObjectProperty(extendedValues[0], 'DataType', x => verifyMapKey(x, serverDataTypes));
    this.lowerVoxelBound =
        verifyObjectProperty(extended, 'MinPoint', x => parseIntVec(vec3.create(), x));
    this.upperVoxelBound =
        verifyObjectProperty(extended, 'MaxPoint', x => parseIntVec(vec3.create(), x));
    this.voxelSize = verifyObjectProperty(
        extended, 'VoxelSize',
        x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    this.numChannels = 1;
  }


  getSources(chunkManager: ChunkManager, parameters: VolumeChunkSourceParameters) {
    let sources: VolumeChunkSource[][] = [];
    // for (let level of levelsArr) {
    for (let level = 0; level < this.numLevels; ++level) {
        let voxelSize = vec3.clone(this.voxelSize);
        let chunkDataSize = vec3.fromValues(64, 64, 64);
        voxelSize[0] = voxelSize[0]*Math.pow(2,level)
        voxelSize[1] = voxelSize[1]*Math.pow(2,level)
        voxelSize[2] = voxelSize[2]*Math.pow(2,level)
        
        let chunkLayout = ChunkLayout.get(vec3.multiply(vec3.create(), voxelSize, chunkDataSize));
        let lowerVoxelBound = vec3.create(), upperVoxelBound = vec3.create();
        for (let i = 0; i < 3; ++i) {
          lowerVoxelBound[i] = Math.floor(this.lowerVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
          upperVoxelBound[i] = Math.ceil(this.upperVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
        }
        let spec = new VolumeChunkSpecification(
            chunkLayout, chunkDataSize, this.numChannels, this.dataType, lowerVoxelBound,
          upperVoxelBound);
        let volParameters: VolumeChunkSourceParameters = {
          'baseUrls': parameters.baseUrls,
          'nodeKey': parameters.nodeKey,
          'dataInstanceKey': parameters.dataInstanceKey,
          'level2': level.toString(),
        };
        let alternatives = [chunkManager.getChunkSource(
          VolumeChunkSource, stableStringify(volParameters),
          () => new VolumeChunkSource(chunkManager, spec, volParameters))];
        
        sources.push(alternatives);
    }
    return sources;
  }
};

export class TileLevelInfo {
  /**
   * Resolution of the two downsampled dimensions in the tile plane.  The tile depth is equal to the
   * base voxel size in that dimension.
   */
  resolution: Vec3;
  tileSize: Vec3;

  constructor (obj: any) {
    verifyObject(obj);
    this.resolution = verifyObjectProperty(
      obj, 'Resolution', x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    this.tileSize = verifyObjectProperty(
      obj, 'TileSize', x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));
  }
};

/**
 * Dimensions for which tiles are computed.
 *
 * FIXME: DVID does not seem to properly indicate which dimensions are available.
 */
const TILE_DIMS = [
  [0, 1, 2],
   [0, 2, 1],
   [1, 2, 0],
];

export class TileChunkSource extends GenericVolumeChunkSource {
  constructor(
    chunkManager: ChunkManager, spec: VolumeChunkSpecification, public parameters: TileChunkSourceParameters) {
    super(chunkManager, spec);
    this.initializeCounterpart(chunkManager.rpc, {
      'type': 'dvid/TileChunkSource',
      'parameters': parameters,
    });
  }
  toString () {
    return tileSourceToString(this.parameters);
  }
};

export class TileDataInstanceInfo extends DataInstanceInfo {
  get dataType () { return DataType.UINT8; }
  get volumeType () { return VolumeType.IMAGE; }
  get numChannels () { return 1; }

  encoding: TileEncoding;

  /**
   * Base voxel size (nm).
   */
  voxelSize: Vec3;

  levels: Map<string, TileLevelInfo>;

  lowerVoxelBound: Vec3;
  upperVoxelBound: Vec3;

  constructor (obj: any, name: string, base: DataInstanceBaseInfo) {
    super(obj, name, base);
    let extended = verifyObjectProperty(obj, 'Extended', verifyObject);
    this.levels = verifyObjectProperty(extended, 'Levels', x => verifyObjectAsMap(x, y => new TileLevelInfo(y)));
    let baseLevel = this.levels.get('0');
    if (baseLevel === undefined) {
      throw new Error(`Level 0 is not defined.`);
    }
    this.voxelSize = baseLevel.resolution;
    let minTileCoord = verifyObjectProperty(
        extended, 'MinTileCoord', x => parseFixedLengthArray(vec3.create(), x, verifyInt));
    let maxTileCoord = verifyObjectProperty(
        extended, 'MaxTileCoord', x => parseFixedLengthArray(vec3.create(), x, verifyInt));
    this.lowerVoxelBound = vec3.multiply(vec3.create(), baseLevel.tileSize, minTileCoord);
    this.upperVoxelBound = vec3.multiply(vec3.create(), baseLevel.tileSize, maxTileCoord);

    let encodingNumber = verifyObjectProperty(extended, 'Encoding', x => x);
    switch (encodingNumber) {
      case 2:
        this.encoding = TileEncoding.JPEG;
        break;
      default:
        throw new Error(`Unsupported tile encoding: ${JSON.stringify(encodingNumber)}.`);
    }
  }

  getSources(chunkManager: ChunkManager, parameters: VolumeChunkSourceParameters): GenericVolumeChunkSource[][] {
    let sources: TileChunkSource[][] = [];
    for (let [level, levelInfo] of this.levels) {
      let alternatives = TILE_DIMS.map(dims => {
        let voxelSize = vec3.clone(this.voxelSize);
        let chunkDataSize = vec3.fromValues(1, 1, 1);
        for (let dim of dims) {
          voxelSize[dim] = levelInfo.resolution[dim];
          chunkDataSize[dim] = levelInfo.tileSize[dim];
        }
        let chunkLayout = ChunkLayout.get(vec3.multiply(vec3.create(), voxelSize, chunkDataSize));
        let lowerVoxelBound = vec3.create(), upperVoxelBound = vec3.create();
        for (let i = 0; i < 3; ++i) {
          lowerVoxelBound[i] = Math.floor(this.lowerVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
          upperVoxelBound[i] = Math.ceil(this.upperVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
        }
        let spec = new VolumeChunkSpecification(
            chunkLayout, chunkDataSize, this.numChannels, this.dataType, lowerVoxelBound,
          upperVoxelBound);
        let tileParameters: TileChunkSourceParameters = {
          'baseUrls': parameters.baseUrls,
          'nodeKey': parameters.nodeKey,
          'level2': '0',
          'dataInstanceKey': parameters.dataInstanceKey,
          'encoding': this.encoding,
          'level': level,
          'dims': `${dims[0]}_${dims[1]}`,
        };
        return chunkManager.getChunkSource(
          VolumeChunkSource, stableStringify(tileParameters),
          () => new TileChunkSource(chunkManager, spec, tileParameters));
      });
      sources.push(alternatives);
    }
    return sources;
  }
};

export function parseDataInstance(obj: any, name: string, keys: Array<string>): DataInstanceInfo {
  verifyObject(obj);
  let baseInfo = verifyObjectProperty(obj, 'Base', x => new DataInstanceBaseInfo(x));
  switch (baseInfo.typeName) {
  case 'uint8blk':
  case 'grayscale8':
    return new VolumeDataInstanceInfo(obj, name, baseInfo, VolumeType.IMAGE, keys);
  case 'imagetile':
    return new TileDataInstanceInfo(obj, name, baseInfo);
  case 'labels64':
  case 'labelblk':
    return new VolumeDataInstanceInfo(obj, name, baseInfo, VolumeType.SEGMENTATION, keys);
  default:
    throw new Error(`DVID data type ${JSON.stringify(baseInfo.typeName)} is not supported.`);
  }
}

export class RepositoryInfo {
  alias: string;
  description: string;
  errors: string[] = [];
  dataInstances = new Map<string, DataInstanceInfo>();
  uuid: string;
  nodes = new Set<string>();
  constructor (obj: any) {
  if (obj===undefined) {
        return;
    }
    verifyObject(obj);
    this.alias = verifyObjectProperty(obj, 'Alias', verifyString);
    this.description = verifyObjectProperty(obj, 'Description', verifyString);
    let dataInstanceObjs = verifyObjectProperty(obj, 'DataInstances', verifyObject);
    for (let key of Object.keys(dataInstanceObjs)) {
      try {
        this.dataInstances.set(key, parseDataInstance(dataInstanceObjs[key], key, Object.keys(dataInstanceObjs)));
      } catch (parseError) {
        let message = `Failed to parse data instance ${JSON.stringify(key)}: ${parseError.message}`;
        console.log(message);
        this.errors.push(message);
      }
    }
    let dagObj = verifyObjectProperty(obj, 'DAG', verifyObject);
    let nodeObjs = verifyObjectProperty(dagObj, 'Nodes', verifyObject);
    for (let key of Object.keys(nodeObjs)) {
        this.nodes.add(key);
    }
  }
};

export function parseRepositoriesInfo(obj: any) {
  try {
    let result = verifyObjectAsMap(obj, x => new RepositoryInfo(x));
   
    let temp = new Map<string, RepositoryInfo>();

    for (let [key, info] of result) {
        temp.set(key,info);
        for (let key2 of info.nodes) {
            if (key2 != key) {
                let rep = new RepositoryInfo(undefined);
                rep.alias = info.alias;
                rep.description = info.description;
                rep.errors = info.errors;
                rep.dataInstances = info.dataInstances;

                temp.set(key2, rep );
            }
        }
    } 
    
    for (let [key, info] of temp) {
        info.uuid = key; 
    }
    // ?! add pointers to new repos



    return temp;
  } catch (parseError) {
    throw new Error(`Failed to parse DVID repositories info: ${parseError.message}`);
  }
}

export class ServerInfo {
  repositories: Map<string, RepositoryInfo>;
  constructor(obj: any) {
    this.repositories = parseRepositoriesInfo(obj);
  }

  getNode (nodeKey: string) {
    // FIXME: Support non-root nodes.
    let matches: string[] = [];
    for (let key of this.repositories.keys()) {
      if (key.startsWith(nodeKey)) {
        matches.push(key);
      }
      }
      // ?!
    if (matches.length !== 1) {
        throw new Error(`Node key ${JSON.stringify(nodeKey)} matches ${JSON.stringify(matches)} nodes.`);
      }
    return this.repositories.get(nodeKey);
  }
};

const cachedServerInfo = new Map<string, Promise<ServerInfo>>();
export function getServerInfo(baseUrls: string[]) {
  let cacheKey = stableStringify(baseUrls);
  let result = cachedServerInfo.get(cacheKey);
  if (result === undefined) {
    result = sendHttpRequest(openShardedHttpRequest(baseUrls, '/api/repos/info', 'GET'), 'json')
                 .then(response => new ServerInfo(response));
    const description = `repository info for DVID server ${baseUrls[0]}`;
    StatusMessage.forPromise(result, {
      initialMessage: `Retrieving ${description}.`,
      delay: true,
      errorPrefix: `Error retrieving ${description}: `,
    });
    cachedServerInfo.set(cacheKey, result);
  }
  return result;
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  get dataType () { return this.info.dataType; }
  get numChannels () { return this.info.numChannels; }
  get volumeType () { return this.info.volumeType; }

  constructor(
      public baseUrls: string[], public nodeKey: string, public dataInstanceKey: string, public level2: string,
      public info: VolumeDataInstanceInfo|TileDataInstanceInfo) {}

  getSources(chunkManager: ChunkManager) {
    return this.info.getSources(chunkManager, {
                    'baseUrls': this.baseUrls,
                    'nodeKey': this.nodeKey,
                    'dataInstanceKey': this.dataInstanceKey,
                    'level2': this.level2,
    });
  }

  /**
   * Meshes are not supported.
   */
  getMeshSource(chunkManager: ChunkManager): null { return null; }
};

let existingVolumes = new Map<string, MultiscaleVolumeChunkSource>();
export function getShardedVolume(baseUrls: string[], nodeKey: string, dataInstanceKey: string, level2: string) {
  return getServerInfo(baseUrls).then(
    serverInfo => {
      let repositoryInfo = serverInfo.getNode(nodeKey);
      let dataInstanceInfo = repositoryInfo.dataInstances.get(dataInstanceKey);
      if (!(dataInstanceInfo instanceof VolumeDataInstanceInfo) &&
          !(dataInstanceInfo instanceof TileDataInstanceInfo)) {
        throw new Error(`Invalid data instance ${dataInstanceKey}.`);
      }
      let cacheKey = stableStringify({
        'baseUrls': baseUrls,
        'nodeKey':repositoryInfo.uuid,
        'dataInstanceKey': dataInstanceKey,
        'level2': level2,
      });
      let result = existingVolumes.get(cacheKey);
      if (result === undefined) {
        result = new MultiscaleVolumeChunkSource(
          baseUrls, repositoryInfo.uuid, dataInstanceKey, level2, dataInstanceInfo);
        existingVolumes.set(cacheKey, result);
      }
      return result;
    });
}

const urlPattern = /^((?:http|https):\/\/[^\/]+)\/([^\/]+)\/([^\/]+)$/;

export function getVolume(url: string) {
  let match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }
  return getShardedVolume([match[1]], match[2], match[3], '0');
}

export function completeInstanceName(repositoryInfo: RepositoryInfo, prefix: string): CompletionResult {
  return {
    offset: 0,
    completions: getPrefixMatchesWithDescriptions<DataInstanceInfo>(
        prefix, repositoryInfo.dataInstances.values(), instance => instance.name,
        instance => { return `${instance.base.typeName}`; })
  };
}

export function completeNodeAndInstance(serverInfo: ServerInfo, prefix: string): CompletionResult {
  let match = prefix.match(/^(?:([^\/]+)(?:\/([^\/]*))?)?$/);
  if (match === null) {
    throw new Error(`Invalid DVID URL syntax.`);
  }
  if (match[2] === undefined) {
    // Try to complete the node name.
    return {
      offset: 0,
      completions: getPrefixMatchesWithDescriptions<RepositoryInfo>(
          prefix, serverInfo.repositories.values(), repository => repository.uuid + '/',
          repository => `${repository.alias}: ${repository.description}`)
    };
  }
  let nodeKey = match[1];
  let repository = serverInfo.getNode(nodeKey);
  return applyCompletionOffset(nodeKey.length + 1, completeInstanceName(repository, match[2]));
}

export function volumeCompleter(url: string): CancellablePromise<CompletionResult> {
  const curUrlPattern = /^((?:http|https):\/\/[^\/]+)\/(.*)$/;
  let match = url.match(curUrlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    return Promise.reject<CompletionResult>(null);
  }
  let baseUrl = match[1];
  let baseUrls = [baseUrl];
  let path = match[2];
  return getServerInfo(baseUrls).then(
      serverInfo =>
          applyCompletionOffset(baseUrl.length + 1, completeNodeAndInstance(serverInfo, path)));
}

registerDataSourceFactory('dvid', {
  description: 'DVID',
  volumeCompleter: volumeCompleter,
  getVolume: getVolume,
});
