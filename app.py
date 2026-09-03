import os
from flask import Flask, render_template, redirect, url_for
from flask_login import LoginManager, current_user
from config import SECRET_KEY
from models.user import User

def create_app():
    app = Flask(__name__)
    app.secret_key = SECRET_KEY

    login_manager = LoginManager()
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'  # type: ignore[assignment]

    @login_manager.user_loader
    def load_user(username):
        return User.get(username)

    from auth import auth_bp
    from api.pages import pages_bp
    from api.user import user_bp

    app.register_blueprint(auth_bp, url_prefix='/auth')
    app.register_blueprint(pages_bp, url_prefix='/api')
    app.register_blueprint(user_bp, url_prefix='/api')

    @app.route('/')
    def index():
        if current_user.is_authenticated:
            return redirect(url_for('workspace'))
        return render_template('index.html')

    @app.route('/about')
    def about():
        return render_template('about.html')

    @app.route('/app')
    def workspace():
        if not current_user.is_authenticated:
            return redirect(url_for('auth.login'))
        return render_template('workspace.html')

    return app

if __name__ == '__main__':
    app = create_app()
    app.run(debug=True, port=5001)
