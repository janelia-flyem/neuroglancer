/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
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

import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {responseJson, cancellableFetchOk, responseArrayBuffer, ResponseTransform} from 'neuroglancer/util/http_request';
import {CredentialsProvider} from 'neuroglancer/credentials_provider';
import {fetchWithCredentials} from 'neuroglancer/credentials_provider/http_request';
// import {DVIDCredentialsProvider} from 'neuroglancer/datasource/dvid/credentials_provider';

export type DVIDToken = string;

export const credentialsKey = 'DVID';

// export type DVIDCredentialsProvider = CredentialsProvider<DVIDToken>;

export interface HttpCall {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  payload?: string;
}

export class DVIDInstance {
  constructor(public baseUrl: string, public nodeKey: string) {}

  getNodeApiUrl(): string {
    return `${this.baseUrl}/api/node/${this.nodeKey}`;
  }
}

function responseText(response: Response): Promise<any> {
  return response.text();
}

export function makeRequest(
  instance: DVIDInstance,
  httpCall: HttpCall & { responseType: 'arraybuffer' },
  cancellationToken?: CancellationToken): Promise<ArrayBuffer>;

export function makeRequest(
  instance: DVIDInstance,
  httpCall: HttpCall & { responseType: 'json' }, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequest(
  instance: DVIDInstance,
  httpCall: HttpCall & { responseType: '' }, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequest(
  instance: DVIDInstance,
  httpCall: HttpCall & { responseType: XMLHttpRequestResponseType },
  cancellationToken: CancellationToken = uncancelableToken): any {
    let requestInfo = `${instance.getNodeApiUrl()}${httpCall.path}`;
    let init = { method: httpCall.method, body: httpCall.payload };

    if (httpCall.responseType === '') {
      return cancellableFetchOk(requestInfo, init, responseText, cancellationToken);
    } else {
      return cancellableFetchOk(requestInfo, init, responseJson, cancellationToken);
    }
}

export function makeRequestWithCredentials(
  instance: DVIDInstance,
  credentialsProvider: CredentialsProvider<DVIDToken>,
  httpCall: HttpCall & { responseType: 'arraybuffer' },
  cancellationToken?: CancellationToken): Promise<ArrayBuffer>;

export function makeRequestWithCredentials(
  instance: DVIDInstance,
  credentialsProvider: CredentialsProvider<DVIDToken>,
  httpCall: HttpCall & { responseType: 'json' }, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequestWithCredentials(
  instance: DVIDInstance,
  credentialsProvider: CredentialsProvider<DVIDToken>,
  httpCall: HttpCall & { responseType: '' }, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequestWithCredentials(
  instance: DVIDInstance, credentialsProvider: CredentialsProvider<DVIDToken>,
  httpCall: HttpCall & { responseType: XMLHttpRequestResponseType },
  cancellationToken: CancellationToken = uncancelableToken): Promise<any> {
    return fetchWithDVIDCredentials(
      credentialsProvider, 
      `${instance.getNodeApiUrl()}${httpCall.path}`, 
      { method: httpCall.method, body: httpCall.payload }, 
      httpCall.responseType === '' ? responseText : (httpCall.responseType === 'json' ? responseJson : responseArrayBuffer),
      cancellationToken
    );
}

export function fetchWithDVIDCredentials<T>(
  credentialsProvider: CredentialsProvider<DVIDToken>,
  input: string,
  init: RequestInit,
  transformResponse: ResponseTransform<T>,
  cancellationToken: CancellationToken = uncancelableToken): Promise<T> {
  return fetchWithCredentials(
    credentialsProvider, input, init, transformResponse,
    credentials => {
      const headers = new Headers(init.headers);
      if (input.startsWith('https')) {
        headers.set('Authorization', `Bearer ${credentials}`);
        headers.set('Access-Control-Allow-Origin', '*');
      }
      return { ...init, headers };
    },
    error => {
      const { status } = error;
      if (status === 403 || status === 401) {
        // Authorization needed.  Retry with refreshed token.
        return 'refresh';
      }
      if (status === 504) {
        // Gateway timeout can occur if the server takes too long to reply.  Retry.
        return 'retry';
      }
      throw error;
    },
    cancellationToken);
}
