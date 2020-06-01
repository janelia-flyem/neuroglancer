/**
 * @license
 * Copyright 2018 Google Inc.
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

import {AnnotationSource} from 'neuroglancer/annotation';
import {MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {LayerDataSource} from 'neuroglancer/layer_data_source';
import {ChunkTransformParameters, getChunkTransformParameters, RenderLayerTransformOrError} from 'neuroglancer/render_coordinate_transform';
import {RenderLayerRole} from 'neuroglancer/renderlayer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableString} from 'neuroglancer/trackable_string';
import {makeCachedLazyDerivedWatchableValue, registerNested, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {makeValueOrError, ValueOrError, valueOrThrow} from 'neuroglancer/util/error';
import {vec3} from 'neuroglancer/util/geom';
import {trackableFiniteFloat} from 'neuroglancer/trackable_finite_float';
import {WatchableMap} from 'neuroglancer/util/watchable_map';
import {makeTrackableFragmentMain, makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {parseShaderUiControls, ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import { TrackableEnum } from '../util/trackable_enum';
import {CompoundTrackable, Trackable} from 'neuroglancer/util/trackable';

export class AnnotationHoverState extends WatchableValue<
    {id: string, partIndex: number, annotationLayerState: AnnotationLayerState}|undefined> {}

// null means loading
// undefined means no attached layer
type OptionalSegmentationDisplayState = SegmentationDisplayState|null|undefined;

export interface AnnotationRelationshipState {
  segmentationState: WatchableValueInterface<OptionalSegmentationDisplayState>;
  showMatches: TrackableBoolean;
}

export class WatchableAnnotationRelationshipStates extends
    WatchableMap<string, AnnotationRelationshipState> {
  constructor() {
    super((context, {showMatches, segmentationState}) => {
      context.registerDisposer(showMatches.changed.add(this.changed.dispatch));
      context.registerDisposer(segmentationState.changed.add(this.changed.dispatch));
      context.registerDisposer(registerNested((nestedContext, segmentationState) => {
        if (segmentationState == null) return;
        const {visibleSegments} = segmentationState;
        let wasEmpty = visibleSegments.size === 0;
        nestedContext.registerDisposer(segmentationState.visibleSegments.changed.add(() => {
          const isEmpty = visibleSegments.size === 0;
          if (isEmpty !== wasEmpty) {
            wasEmpty = isEmpty;
            this.changed.dispatch();
          }
        }));
      }, segmentationState));
    });
  }

  get(name: string): AnnotationRelationshipState {
    let value = super.get(name);
    if (value === undefined) {
      value = {
        segmentationState: new WatchableValue(undefined),
        showMatches: new TrackableBoolean(false)
      };
      super.set(name, value);
    }
    return value;
  }
}

const DEFAULT_FRAGMENT_MAIN = `
void main() {
  setColor(defaultColor());
}
`;

export enum FilterAnnotationByTimeType {
  ALL = 0,
  TODAY = 1,
  RECENT = 2
};

export class TrackableFilterAnnotationByTime extends TrackableEnum<FilterAnnotationByTimeType>
{
  constructor(value = FilterAnnotationByTimeType.ALL) {
    super(FilterAnnotationByTimeType, value);
  }
}

export class AnnotationDisplayState extends RefCounted {
  shader = makeTrackableFragmentMain(DEFAULT_FRAGMENT_MAIN);
  shaderControls = new ShaderControlState(this.shader);
  fallbackShaderControls = new WatchableValue(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN));
  shaderError = makeWatchableShaderError();
  color = new TrackableRGB(vec3.fromValues(1, 1, 0));
  relationshipStates = this.registerDisposer(new WatchableAnnotationRelationshipStates());
  ignoreNullSegmentFilter = new TrackableBoolean(true);
  displayUnfiltered = makeCachedLazyDerivedWatchableValue((map, ignoreNullSegmentFilter) => {
    for (const state of map.values()) {
      if (state.showMatches.value) {
        if (!ignoreNullSegmentFilter) return false;
        const segmentationState = state.segmentationState.value;
        if (segmentationState != null) {
          if (segmentationState.visibleSegments.size > 0) {
            return false;
          }
        }
      }
    }
    return true;
  }, this.relationshipStates, this.ignoreNullSegmentFilter);
  hoverState = new AnnotationHoverState(undefined);
  pointRadius = trackableFiniteFloat(6);
  tableFilterByText = new TrackableString('');
  tableFilterByTime = new TrackableFilterAnnotationByTime();
  // tableFilterByToday = new TrackableBoolean(false);
}

class AnnotationToolDefaultProperty implements Trackable {
  private compound = new CompoundTrackable();
  get changed() {
    return this.compound.changed;
  }

  type = new TrackableString("");
  hint = new TrackableString("");

  constructor() {
    const {compound} = this;
    compound.add('type', this.type);
    compound.add('hint', this.hint);
  }

  reset() {
    this.compound.reset();
  }

  restoreState(obj: any) {
    if (obj === undefined) return;
    this.compound.restoreState(obj);
  }

  toJSON(): any {
    const obj = this.compound.toJSON();
    for (const _ in obj) return obj;
    return undefined;
  }
}

export class AnnotationDefaultProperty implements Trackable {
  private compound = new CompoundTrackable();
  get changed() {
    return this.compound.changed;
  }

  point = new AnnotationToolDefaultProperty;

  constructor() {
    const {compound} = this;
    compound.add('point', this.point);
  }

  reset() {
    this.compound.reset();
  }

  restoreState(obj: any) {
    if (obj === undefined) return;
    this.compound.restoreState(obj);
  }

  toJSON(): any {
    const obj = this.compound.toJSON();
    for (const _ in obj) return obj;
    return undefined;
  }
}

export class AnnotationLayerState extends RefCounted {
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  localPosition: WatchableValueInterface<Float32Array>;
  source: Owned<AnnotationSource|MultiscaleAnnotationSource>;
  role: RenderLayerRole;
  dataSource: LayerDataSource;
  subsourceId: string;
  subsourceIndex: number;
  displayState: AnnotationDisplayState;
  defaultProperty: AnnotationDefaultProperty;

  readonly chunkTransform: WatchableValueInterface<ValueOrError<ChunkTransformParameters>>;

  constructor(options: {
    transform: WatchableValueInterface<RenderLayerTransformOrError>,
    localPosition: WatchableValueInterface<Float32Array>,
    source: Owned<AnnotationSource|MultiscaleAnnotationSource>,
    displayState: AnnotationDisplayState,
    dataSource: LayerDataSource,
    subsourceId: string,
    subsourceIndex: number,
    defaultProperty: AnnotationDefaultProperty,
    role?: RenderLayerRole
  }) {
    super();
    const {
      transform,
      localPosition,
      source,
      role = RenderLayerRole.ANNOTATION,
    } = options;
    this.transform = transform;
    this.localPosition = localPosition;
    this.source = this.registerDisposer(source);
    this.role = role;
    this.displayState = options.displayState;
    this.chunkTransform = this.registerDisposer(makeCachedLazyDerivedWatchableValue(
        modelTransform =>
            makeValueOrError(() => getChunkTransformParameters(valueOrThrow(modelTransform))),
        this.transform));
    this.dataSource = options.dataSource;
    this.subsourceId = options.subsourceId;
    this.subsourceIndex = options.subsourceIndex;
    this.defaultProperty = options.defaultProperty;
  }

  get sourceIndex() {
    const {dataSource} = this;
    return dataSource.layer.dataSources.indexOf(dataSource);
  }
}
