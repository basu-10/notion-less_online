import re
import secrets
from flask import Blueprint, request, render_template, redirect, url_for, flash, jsonify, session
from flask_login import login_user, logout_user, login_required, current_user
from models.user import User

USERNAME_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{3,32}$')
PASSWORD_MIN_LENGTH = 8

auth_bp = Blueprint('auth', __name__)

def generate_csrf_token():
    if 'csrf_token' not in session:
        session['csrf_token'] = secrets.token_hex(32)
    return session['csrf_token']

def validate_csrf_token():
    token = session.pop('csrf_token', None)
    return token and request.form.get('csrf_token') == token

@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('workspace'))
    if request.method == 'GET':
        return render_template('auth/register.html', csrf_token=generate_csrf_token())
    if not validate_csrf_token():
        flash('Invalid request token')
        return redirect(url_for('auth.register'))
    username = request.form.get('username', '').strip()
    password = request.form.get('password', '')
    if not username or not password:
        flash('Username and password required')
        return redirect(url_for('auth.register'))
    if not USERNAME_PATTERN.match(username):
        flash('Username must be 3-32 alphanumeric characters (a-z, A-Z, 0-9, _, -)')
        return redirect(url_for('auth.register'))
    if len(password) < PASSWORD_MIN_LENGTH:
        flash(f'Password must be at least {PASSWORD_MIN_LENGTH} characters')
        return redirect(url_for('auth.register'))
    user = User.create(username, password)
    if not user:
        flash('Username taken or invalid')
        return redirect(url_for('auth.register'))
    login_user(user)
    return redirect(url_for('workspace'))

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('workspace'))
    if request.method == 'GET':
        return render_template('auth/login.html', csrf_token=generate_csrf_token())
    if not validate_csrf_token():
        flash('Invalid request token')
        return redirect(url_for('auth.login'))
    username = request.form.get('username', '').strip()
    password = request.form.get('password', '')
    user = User.authenticate(username, password)
    if not user:
        flash('Invalid credentials')
        return redirect(url_for('auth.login'))
    login_user(user)
    return redirect(url_for('workspace'))

@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('auth.login'))
