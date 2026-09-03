class ApiClient {
  constructor() {
    this.base = '/api';
    this.etags = {};
  }

  async request(method, path, body) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: {}
    };
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body) {
      opts.body = body;
    }
    const res = await fetch(`${this.base}${path}`, opts);
    if (res.status === 401) {
      window.location.href = '/auth/login';
      throw new Error('Unauthorized');
    }
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  delete(path) { return this.request('DELETE', path); }

  async me() { return this.get('/me'); }
  async exportProfile() { return this.get('/export'); }
  async importProfile(data) { return this.post('/import', data); }

  async listPages() { return this.get('/pages'); }
  async listPagesMeta() { return this.get('/pages/list'); }
  async createPage(data) { return this.post('/pages', data); }
  async getPage(id) { return this.get(`/pages/${id}`); }
  async updatePage(id, data) { return this.put(`/pages/${id}`, data); }
  async deletePage(id) { return this.delete(`/pages/${id}`); }

  async uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${this.base}/upload`, {
      method: 'POST',
      credentials: 'same-origin',
      body: formData
    });
    if (res.status === 401) {
      window.location.href = '/auth/login';
      throw new Error('Unauthorized');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  }
}

window.api = new ApiClient();
