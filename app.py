import os
from flask import Flask, render_template, redirect, url_for, jsonify, request
from flask_login import LoginManager, current_user
from config import SECRET_KEY
from models.user import User

def create_app():
    app = Flask(__name__)
    app.secret_key = SECRET_KEY

    login_manager = LoginManager()
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'

    @login_manager.user_loader
    def load_user(username):
        return User.get(username)

    from auth import auth_bp
    from api.pages import pages_bp
    from api.user import user_bp
    from api.social import social_bp
    from api.extension import extension_bp

    app.register_blueprint(auth_bp, url_prefix='/auth')
    app.register_blueprint(pages_bp, url_prefix='/api')
    app.register_blueprint(user_bp, url_prefix='/api')
    app.register_blueprint(social_bp, url_prefix='/api')
    app.register_blueprint(extension_bp, url_prefix='/api')

    from flask_login import login_user
    @app.route('/api/auth/login', methods=['POST'])
    def api_auth_login():
        data = request.get_json(silent=True) or {}
        username = str(data.get('username', '')).strip()
        password = str(data.get('password', ''))
        user = User.authenticate(username, password)
        if not user:
            return jsonify({'error': 'Invalid credentials'}), 401
        login_user(user)
        return jsonify({'username': user.username})

    @app.route('/')
    def index():
        return render_template('index.html')

    @app.route('/about')
    def about():
        return render_template('about.html')

    @app.route('/faq')
    def faq():
        return render_template('faq.html')

    @app.route('/search')
    def search():
        return render_template('search.html')

    @app.route('/wall/<username>')
    def wall(username):
        if not User.exists(username):
            return render_template('404.html', message='User not found'), 404
        return render_template('wall.html', username=username)

    @app.route('/p/<username>/<page_id>')
    def public_page(username, page_id):
        if not User.exists(username):
            return render_template('404.html', message='User not found'), 404
        return render_template('public_page.html', username=username, page_id=page_id)

    @app.route('/workspace_direct')
    def workspace_direct():
        return render_template('workspace.html')

    @app.route('/app')
    def workspace():
        if not current_user.is_authenticated:
            return redirect(url_for('auth.login'))
        return render_template('workspace.html', username=current_user.username)

    return app

if __name__ == '__main__':
    app = create_app()
    app.run(debug=True, port=5001)
