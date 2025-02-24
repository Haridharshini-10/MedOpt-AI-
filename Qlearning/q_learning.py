import numpy as np
import random
from flask import Flask, request, jsonify
from flask_cors import CORS  # ✅ Import CORS

app = Flask(__name__)
CORS(app)  # ✅ Enable CORS

# Define environment (states, actions, rewards)
states = ["Missed", "Late", "On Time"]
actions = ["Remind Early", "Remind On Time", "Remind Late"]

# Initialize Q-table
q_table = np.zeros((len(states), len(actions)))

# Hyperparameters
alpha = 0.1  # Learning rate
gamma = 0.9  # Discount factor
epsilon = 0.2  # Exploration-exploitation trade-off

# Reward function
def get_reward(state, action):
    if state == "Missed" and action == "Remind Early":
        return 1  # Positive reward
    elif state == "Late" and action == "Remind On Time":
        return 1
    elif state == "On Time":
        return 2  # Best outcome
    else:
        return -1  # Negative reward

# Q-learning Algorithm
def train_q_learning(episodes=1000):
    for _ in range(episodes):
        state = random.choice(states)
        state_index = states.index(state)

        if random.uniform(0, 1) < epsilon:
            action_index = random.choice(range(len(actions)))  # Explore
        else:
            action_index = np.argmax(q_table[state_index])  # Exploit best known action

        action = actions[action_index]
        reward = get_reward(state, action)

        next_state = random.choice(states)  # Simulating next state
        next_state_index = states.index(next_state)

        q_table[state_index, action_index] = (1 - alpha) * q_table[state_index, action_index] + alpha * (
            reward + gamma * np.max(q_table[next_state_index])
        )

# Train model initially
train_q_learning()

@app.route("/get-reminder", methods=["POST"])
def get_reminder():
    try:
        data = request.json
        print("Received Request Data:", data)  # ✅ Debugging log
        state = data.get("state", "Missed")

        if state not in states:
            return jsonify({"error": "Invalid state"}), 400

        state_index = states.index(state)
        best_action_index = np.argmax(q_table[state_index])
        best_action = actions[best_action_index]

        print("Selected Reminder:", best_action)  # ✅ Debugging log
        return jsonify({"reminder": best_action})

    except Exception as e:
        print("Error in get_reminder:", str(e))  # ✅ Debugging log
        return jsonify({"error": "Internal Server Error", "message": str(e)}), 500
@app.route("/update-qlearning", methods=["POST"])
def update_qlearning():
    try:
        data = request.json
        state = data.get("state", "Missed")  
        action = data.get("action", "Remind Early")  

        if state not in states or action not in actions:
            return jsonify({"error": "Invalid state or action"}), 400

        state_index = states.index(state)
        action_index = actions.index(action)

        reward = get_reward(state, action)

        # ✅ Q-learning update step
        q_table[state_index, action_index] = (1 - alpha) * q_table[state_index, action_index] + alpha * reward

        return jsonify({"message": "Q-learning updated successfully!", "q_table": q_table.tolist()})

    except Exception as e:
        print("Error in update_qlearning:", str(e))
        return jsonify({"error": "Internal Server Error", "message": str(e)}), 500



if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002, debug=True)
