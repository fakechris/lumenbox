import json
from PyQt5.QtWidgets import QApplication, QWidget, QVBoxLayout, QPushButton, QLineEdit, QLabel

app = QApplication([])
window = QWidget()
window.setWindowTitle('CUA Qt Fixture')
window.resize(420, 260)
layout = QVBoxLayout(window)
state = {'clicks': 0, 'text': ''}
def save():
    with open('/tmp/cua-qt-state.json', 'w') as output:
        json.dump(state, output)
label = QLabel('No Qt clicks')
button = QPushButton('Increment Qt fixture')
def increment():
    state['clicks'] += 1
    label.setText('Qt clicks: ' + str(state['clicks']))
    save()
button.clicked.connect(increment)
entry = QLineEdit()
entry.setAccessibleName('Qt fixture value')
def changed(value):
    state['text'] = value
    save()
entry.textChanged.connect(changed)
for widget in (button, label, entry):
    layout.addWidget(widget)
save()
window.show()
app.exec_()
