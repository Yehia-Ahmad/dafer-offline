import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

/** Stage 24: GET /api/license/info (owner): the license of this shop's main PC and the client PCs paired to it. */
export interface PairedClient {
  deviceId: string;
  name: string;
  lastSeenAt: string | null;
  pairedAt: string | null;
}

/** A client PC the owner removed: it cannot pair itself again until the owner allows it. */
export interface RevokedClient {
  deviceId: string;
  name: string;
  revokedAt: string | null;
}

export interface LicenseInfo {
  licenseId: string;
  /** Only 'lifetime' exists today. */
  type: string;
  shopName: string;
  shopNameEn: string | null;
  machineId: string;
  maxClients: number;
  issuedAt: string;
  clientsUsed: number;
  clients: PairedClient[];
  /** Absent on an older backend. */
  revoked?: RevokedClient[];
}

@Injectable({ providedIn: 'root' })
export class LicenseService {
  private readonly baseUrl = `${environment.api_base_url}license`;

  constructor(private readonly http: HttpClient) {}

  info(): Observable<LicenseInfo> {
    return this.http.get<LicenseInfo>(`${this.baseUrl}/info`);
  }

  /** Replaces the license (owner). The backend answers 400 LICENSE_INVALID with a `reason` when it refuses the text. */
  replace(license: string): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/activate`, { license });
  }

  /** The owner lets a removed (revoked) PC pair again. It still needs a free slot and pairs itself the next time it signs in. */
  allow(deviceId: string): Observable<{ allowed: boolean }> {
    return this.http.post<{ allowed: boolean }>(`${this.baseUrl}/clients/${encodeURIComponent(deviceId)}/allow`, {});
  }

  /** Frees one client PC's slot and removes (revokes) it. */
  unpair(deviceId: string): Observable<{ unpaired: boolean }> {
    return this.http.delete<{ unpaired: boolean }>(`${this.baseUrl}/clients/${encodeURIComponent(deviceId)}`);
  }
}
