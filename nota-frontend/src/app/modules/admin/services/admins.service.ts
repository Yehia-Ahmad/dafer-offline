import { Injectable } from '@angular/core';
import { environment } from '../../../../environments/environment';
import { HttpClient } from '@angular/common/http';
import { removeNullishFieldsParams } from '../../../core/utilities/helper-function';

@Injectable({
  providedIn: 'root'
})
export class AdminsService {
  baseUrl = environment.api_base_url;

  constructor(private _http: HttpClient) { }

  getAllUsers(params?: any) {
    return this._http.get(`${this.baseUrl}users`, { params });
  }

  deleteUser(id: number) {
    return this._http.delete(`${this.baseUrl}users/${id}`);
  }

  getUserById(id: number) {
    return this._http.get(`${this.baseUrl}users/${id}`);
  }

  updateUser(id: number, user: any) {
    user = removeNullishFieldsParams(user);
    return this._http.patch(`${this.baseUrl}users/${id}`, user);
  }

  createUser(admin: any) {
    return this._http.post(`${this.baseUrl}auth/signup`, admin);
  }
  
}
