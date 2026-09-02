from flask import Blueprint, request, render_template, redirect, url_for, flash, jsonify
from flask_login import login_user, logout_user, login_required, current_user
from models.user import User

auth_bp = Blueprint('auth', __name__)

@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('workspace'))
    if request.method == 'GET':
        return render_template('auth/register.html')
    username = request.form.get('username', '').strip()
    password = request.form.get('password', '')
    if not username or not password:
        flash('Username and password required')
        return redirect(url_for('auth.register'))
    if len(username) < 3 or len(password) < 6:
        flash('Username must be 3+ chars, password 6+ chars')
        return redirect(url_for('auth.register'))
    user = User.create(username, password)
    if not user:
        flash('Username taken')
        return redirect(url_for('auth.register'))
    login_user(user)
    return redirect(url_for('workspace'))

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('workspace'))
    if request.method == 'GET':
        return render_template('auth/login.html')
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
